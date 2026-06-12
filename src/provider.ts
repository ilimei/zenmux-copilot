import * as vscode from "vscode";
import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  ProvideLanguageModelChatResponseOptions,
  LanguageModelResponsePart2,
  Progress,
} from "vscode";

import { createRetryConfig, ensureApiKey, executeWithRetry, fetchModels } from "./utils";
import {
  buildCustomEndpointUrl,
  normalizeZenMuxModel,
  NormalizedZenMuxModel,
  ZenMuxApiType,
  getReasoningConfigurationSchema,
} from "./modelCapabilities";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { prepareTokenCount } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OpenaiApi } from "./openai/openaiApi";
import { ZenMuxModelInfo } from "./types";


const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const MODEL_REFRESH_TTL_MS = 5 * 60 * 1000;

/**
 * VS Code Chat provider backed by ZenMux Inference Providers.
 */
export class ZenMuxChatModelProvider implements LanguageModelChatProvider {
  /** Track last request completion time for delay calculation. */
  private _lastRequestTime: number | null = null;

  private _models: ZenMuxModelInfo[] = [];
  private _normalizedModels = new Map<string, NormalizedZenMuxModel>();
  private _languageModels: vscode.LanguageModelChatInformation[] = [];
  private _languageModelsFetchedAt = 0;
  private _refreshModelsPromise: Promise<void> | undefined;
  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  /**
 * Create a provider using the given secret storage for the API key.
 * @param secrets VS Code secret storage.
 */
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly userAgent: string,
    private readonly statusBarItem: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel,
    private readonly onRequestComplete?: () => void | Promise<void>
  ) { }

  /**
   * Get the list of available language models contributed by this provider
   * @param options Options which specify the calling context of this function
   * @param token A cancellation token which signals if the user cancelled the request or not
   * @returns A promise that resolves to the list of available language models
   */
  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    if (!options.silent || this._languageModels.length === 0 || this.isModelCacheExpired()) {
      await this.refreshModels(options.silent);
    }
    return this._languageModels;
  }

  async refreshModels(silent: boolean): Promise<void> {
    if (this._refreshModelsPromise) {
      return this._refreshModelsPromise;
    }

    this._refreshModelsPromise = this.doRefreshModels(silent).finally(() => {
      this._refreshModelsPromise = undefined;
    });
    return this._refreshModelsPromise;
  }

  private async doRefreshModels(silent: boolean): Promise<void> {
    const apiKey = await ensureApiKey(silent, this.secrets);
    if (!apiKey) {
      this._models = [];
      this._normalizedModels.clear();
      this._languageModels = [];
      this._languageModelsFetchedAt = 0;
      this._onDidChangeLanguageModelChatInformation.fire();
      if (silent) {
        return;
      } else {
        throw new Error("ZenMux API key not found");
      }
    }
    const { models } = await fetchModels(apiKey, this.userAgent, this.output);
    const normalizedModels = models.map(normalizeZenMuxModel);
    const chatModels = normalizedModels.filter((m) => m.isChatModel);
    this._models = chatModels.map((m) => m.model);
    this._normalizedModels = new Map(chatModels.map((m) => [m.model.slug ?? m.model.id, m]));
    this.output.appendLine(`Fetched ${models.length} models from ZenMux API, exposing ${chatModels.length} chat-capable models.`);
    this._languageModels = chatModels.map(normalizedModel => {
      const m = normalizedModel.model;
      const contextLength = m.context_length || DEFAULT_CONTEXT_LENGTH;
      let maxOutputTokens = m.max_completion_tokens || DEFAULT_MAX_TOKENS;
      // Some models report max_completion_tokens equal (or close) to context_length,
      // meaning input and output share the context window. Clamp the output budget
      // so the input budget never collapses to ~0 (which makes VS Code prune all history).
      const maxOutputCap = Math.max(1, Math.floor(contextLength / 4));
      if (maxOutputTokens > maxOutputCap) {
        maxOutputTokens = Math.min(maxOutputTokens, Math.max(maxOutputCap, DEFAULT_MAX_TOKENS));
      }
      const maxInput = Math.max(1, contextLength - maxOutputTokens);
      const modelId = m.slug ?? m.id;
      return {
        id: modelId,
        name: m.name ?? m.display_name ?? m.id,
        tooltip: 'ZenMux Model ' + (m.name ?? m.display_name ?? m.id),
        detail: 'ZenMux',
        family: normalizedModel.adapterProtocol,
        version: m.publish_time || (m.created ? String(m.created) : '1.0.0'),
        maxInputTokens: maxInput,
        maxOutputTokens,
        capabilities: normalizedModel.capabilities,
        ...(normalizedModel.supportsReasoning
          ? { configurationSchema: getReasoningConfigurationSchema(normalizedModel.adapterProtocol) }
          : {}),
      } as LanguageModelChatInformation;
    });
    this._languageModelsFetchedAt = Date.now();
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<vscode.LanguageModelResponsePart>,
    token: CancellationToken) {
    const zenMuxModel = this._models.find(m => (m.slug ?? m.id) === model.id);
    const normalizedModel = this._normalizedModels.get(model.id) ?? (zenMuxModel ? normalizeZenMuxModel(zenMuxModel) : undefined);
    const effectiveZenMuxModel = zenMuxModel && normalizedModel
      ? { ...zenMuxModel, supported_parameters: normalizedModel.selectedSupportedParameters }
      : zenMuxModel;
    const supportParameters = Array.isArray(effectiveZenMuxModel?.supported_parameters)
      ? effectiveZenMuxModel.supported_parameters.join(",")
      : effectiveZenMuxModel?.supported_parameters || "";
    // Update Token Usage
    updateContextStatusBar(messages, model, this.statusBarItem);

    // Apply delay between consecutive requests
    const config = vscode.workspace.getConfiguration();
    const delayMs = config.get<number>("zenmux.delay", 0);

    if (delayMs > 0 && this._lastRequestTime !== null) {
      const elapsed = Date.now() - this._lastRequestTime;
      if (elapsed < delayMs) {
        const remainingDelay = delayMs - elapsed;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            clearTimeout(timeout);
            resolve();
          }, remainingDelay);
        });
      }
    }

    const trackingProgress: Progress<LanguageModelResponsePart2> = {
      report: (part) => {
        try {
          // @ts-expect-error not error
          progress.report(part);
        } catch (e) {
          const msg = `[ZenMux Model Provider] Progress.report failed modelId=${model.id} error=${e instanceof Error ? e.message : String(e)}`;
          try { this.output.appendLine(msg); } catch { console.error(msg); }
        }
      },
    };

    try {
      const apiKey = await ensureApiKey(false, this.secrets);
      if (!apiKey) {
        throw new Error("ZenMux API key not found");
      }
      const config = vscode.workspace.getConfiguration();
      const apiType = normalizedModel?.apiType ?? "chat-completions";
      if (apiType !== "messages" && apiType !== "chat-completions") {
        throw new Error(`ZenMux ${apiType} API routing is detected, but request conversion is not implemented yet.`);
      }
      const requestUrl = buildCustomEndpointUrl(this.getBaseUrlForApiType(config, apiType), apiType);

      if (apiType === "messages") {
        // Anthropic API mode
        const anthropicApi = new AnthropicApi();
        const anthropicMessages = anthropicApi.convertMessages(messages, {
          includeReasoningInRequest: normalizedModel?.supportsReasoning ?? false,
          supportParameters,
        });

        // requestBody
        let requestBody: AnthropicRequestBody = {
          model: model.id,
          messages: anthropicMessages,
          stream: true,
          max_tokens: model.maxOutputTokens || DEFAULT_MAX_TOKENS,
        };
        requestBody = anthropicApi.prepareRequestBody(requestBody, effectiveZenMuxModel, options);

        // send Anthropic chat request with retry
        const response = await executeWithRetry(async () => {
          const res = await fetch(requestUrl, {
            method: "POST",
            headers: this.getRequestHeaders(apiType, apiKey),
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            const msg = `[Anthropic Provider] Anthropic API error response status=${res.status} statusText=${res.statusText} body=${errorText}`;
            try { this.output.appendLine(msg); } catch { console.error(msg); }
            throw new Error(
              `Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`
            );
          }

          return res;
        }, createRetryConfig());

        if (!response.body) {
          throw new Error("No response body from Anthropic API");
        }
        await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
      } else {
        // OpenAI compatible API mode (default)
        const openaiApi = new OpenaiApi();
        const openaiMessages = openaiApi.convertMessages(messages, {
          includeReasoningInRequest: false,
          supportParameters,
        });

        // requestBody
        let requestBody: Record<string, unknown> = {
          model: model.id,
          messages: openaiMessages,
          stream: true,
          stream_options: { include_usage: true },
        };
        requestBody = openaiApi.prepareRequestBody(requestBody, effectiveZenMuxModel, options);
        // console.debug("[ZenMux Model Provider] RequestBody:", JSON.stringify(requestBody));

        // send chat request with retry
        const response = await executeWithRetry(async () => {
          const res = await fetch(requestUrl, {
            method: "POST",
            headers: this.getRequestHeaders(apiType, apiKey),
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            const msg = `[ZenMux Provider] ZenMux API error response status=${res.status} statusText=${res.statusText} body=${errorText}`;
            try { this.output.appendLine(msg); } catch { console.error(msg); }
            throw new Error(
              `[ZenMux Provider] ZenMux API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}`
            );
          }

          return res;
        }, createRetryConfig());

        if (!response.body) {
          const msg = "[ZenMux Provider] No response body from ZenMux API";
          try { this.output.appendLine(msg); } catch { console.error(msg); }
          throw new Error("No response body from ZenMux API");
        }
        await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
      }
    } catch (err) {
      console.error("[ZenMux Model Provider] Chat request failed", {
        modelId: model.id,
        messageCount: messages.length,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      throw err;
    } finally {
      // Update last request time after successful completion
      this._lastRequestTime = Date.now();
      Promise.resolve(this.onRequestComplete?.()).catch((error) => {
        try {
          this.output.appendLine(`[ZenMux Model Provider] Request completion hook failed: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          console.error("[ZenMux Model Provider] Request completion hook failed", error);
        }
      });
    }
  }

  private isModelCacheExpired(): boolean {
    return this._languageModelsFetchedAt === 0 || Date.now() - this._languageModelsFetchedAt > MODEL_REFRESH_TTL_MS;
  }

  private getBaseUrlForApiType(config: vscode.WorkspaceConfiguration, apiType: ZenMuxApiType): string {
    switch (apiType) {
      case "messages":
        return config.get<string>("zenmux.anthropic.baseUrl", "https://zenmux.ai/api/anthropic");
      default:
        return config.get<string>("zenmux.baseUrl", "https://zenmux.ai/api/v1");
    }
  }

  private getRequestHeaders(apiType: ZenMuxApiType, apiKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };

    if (apiType === "messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      return headers;
    }

    headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  /**
   * Returns the number of tokens for a given text using the model specific tokenizer logic
   * @param model The language model to use
   * @param text The text to count tokens for
   * @param token A cancellation token for the request
   * @returns A promise that resolves to the number of tokens
   */
  async provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    _token: CancellationToken
  ): Promise<number> {
    return prepareTokenCount(model, text, _token);
  }
}
