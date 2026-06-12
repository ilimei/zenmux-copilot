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

import { createRetryConfig, ensureApiKey, executeWithRetry, fetchModels, mapRole } from "./utils";
import {
  buildCustomEndpointUrl,
  normalizeZenMuxModel,
  NormalizedZenMuxModel,
  ZenMuxApiType,
  getModelConfigurationSchema,
} from "./modelCapabilities";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { prepareTokenCount } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { OpenaiApi } from "./openai/openaiApi";


const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const MODEL_REFRESH_TTL_MS = 5 * 60 * 1000;
const MIN_INPUT_TOKENS = 1;

/**
 * VS Code Chat provider backed by ZenMux Inference Providers.
 */
export class ZenMuxChatModelProvider implements LanguageModelChatProvider {
  /** Track last request completion time for delay calculation. */
  private _lastRequestTime: number | null = null;

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
    this._normalizedModels = new Map(chatModels.map((m) => [m.model.slug ?? m.model.id, m]));
    this.output.appendLine(`Fetched ${models.length} models from ZenMux API, exposing ${chatModels.length} chat-capable models.`);
    const maxContextTokens = this.getConfiguredMaxContextTokens();
    this._languageModels = chatModels.map(normalizedModel => {
      const m = normalizedModel.model;
      const rawContextLength = m.context_length || DEFAULT_CONTEXT_LENGTH;
      const contextLength = maxContextTokens ? Math.min(rawContextLength, maxContextTokens) : rawContextLength;
      let maxOutputTokens = m.max_completion_tokens || DEFAULT_MAX_TOKENS;
      // Some models report max_completion_tokens equal (or close) to context_length,
      // meaning input and output share the context window. Clamp the output budget
      // so the input budget never collapses to ~0 (which makes VS Code prune all history).
      const maxOutputCap = Math.max(MIN_INPUT_TOKENS, Math.floor(contextLength / 4));
      if (maxOutputTokens > maxOutputCap) {
        maxOutputTokens = Math.min(maxOutputTokens, Math.max(maxOutputCap, DEFAULT_MAX_TOKENS));
      }
      const maxInput = Math.max(MIN_INPUT_TOKENS, contextLength - maxOutputTokens);
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
        configurationSchema: getModelConfigurationSchema(normalizedModel.adapterProtocol, normalizedModel.supportsReasoning),
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
    const normalizedModel = this._normalizedModels.get(model.id);
    if (!normalizedModel) {
      throw new Error(`ZenMux model metadata is unavailable for ${model.id}. Refresh the model list and try again.`);
    }
    const supportParameters = Array.isArray(normalizedModel.selectedSupportedParameters)
      ? normalizedModel.selectedSupportedParameters.join(",")
      : normalizedModel.selectedSupportedParameters || "";
    const effectiveModel = this.createEffectiveModelInfo(model, normalizedModel, options);
    const requestMessages = await this.truncateMessagesToContext(messages, effectiveModel, token);

    // Update Token Usage
    updateContextStatusBar(requestMessages, effectiveModel, this.statusBarItem);

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
        const anthropicMessages = anthropicApi.convertMessages(requestMessages, {
          includeReasoningInRequest: normalizedModel?.supportsReasoning ?? false,
          supportParameters,
          cacheTtl: this.getAnthropicCacheTtl(config),
          hasToolDefinitions: (options.tools?.length ?? 0) > 0 && normalizedModel.supportsTools,
        });

        // requestBody
        let requestBody: AnthropicRequestBody = {
          model: model.id,
          messages: anthropicMessages,
          stream: true,
          max_tokens: effectiveModel.maxOutputTokens || DEFAULT_MAX_TOKENS,
        };
        requestBody = anthropicApi.prepareRequestBody(requestBody, normalizedModel, options);

        const responseBody = await this.fetchStreamingResponseBody(apiType, apiKey, requestUrl, requestBody, "Anthropic Provider");
        await anthropicApi.processStreamingResponse(responseBody, trackingProgress, token);
      } else {
        // OpenAI compatible API mode (default)
        const openaiApi = new OpenaiApi();
        const openaiMessages = openaiApi.convertMessages(requestMessages, {
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
        requestBody = openaiApi.prepareRequestBody(requestBody, normalizedModel, options);
        // console.debug("[ZenMux Model Provider] RequestBody:", JSON.stringify(requestBody));

        const responseBody = await this.fetchStreamingResponseBody(apiType, apiKey, requestUrl, requestBody, "ZenMux Provider");
        await openaiApi.processStreamingResponse(responseBody, trackingProgress, token);
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

  private getConfiguredMaxContextTokens(): number | undefined {
    const configured = vscode.workspace.getConfiguration().get<number | string>("zenmux.maxContextTokens", 0);
    return this.parseContextWindowTokens(configured);
  }

  private parseContextWindowTokens(value: unknown): number | undefined {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === "auto") {
        return undefined;
      }
      const multiplier = normalized.endsWith("m") ? 1_000_000 : normalized.endsWith("k") ? 1_000 : 1;
      const numeric = Number(normalized.replace(/[km]$/, ""));
      return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric * multiplier) : undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  private createEffectiveModelInfo(
    model: vscode.LanguageModelChatInformation,
    normalizedModel: NormalizedZenMuxModel,
    options: ProvideLanguageModelChatResponseOptions
  ): vscode.LanguageModelChatInformation {
    const rawContextLength = normalizedModel.model.context_length || model.maxInputTokens + model.maxOutputTokens || DEFAULT_CONTEXT_LENGTH;
    const configuredContext = this.getConfiguredMaxContextTokens();
    const selectedContext = this.getConfiguredContextSize(options);
    const contextLength = Math.min(
      rawContextLength,
      configuredContext ?? rawContextLength,
      selectedContext ?? rawContextLength
    );
    if (contextLength === model.maxInputTokens + model.maxOutputTokens) {
      return model;
    }

    let maxOutputTokens = model.maxOutputTokens || DEFAULT_MAX_TOKENS;
    const maxOutputCap = Math.max(MIN_INPUT_TOKENS, Math.floor(contextLength / 4));
    if (maxOutputTokens > maxOutputCap) {
      maxOutputTokens = Math.min(maxOutputTokens, Math.max(maxOutputCap, DEFAULT_MAX_TOKENS));
    }

    const effectiveModel = {
      ...model,
      maxInputTokens: Math.max(MIN_INPUT_TOKENS, contextLength - maxOutputTokens),
      maxOutputTokens,
    };
    this.output.appendLine(
      `Using contextSize=${contextLength} for model=${model.id}, maxInputTokens=${effectiveModel.maxInputTokens}, maxOutputTokens=${effectiveModel.maxOutputTokens}.`
    );
    return effectiveModel;
  }

  private getConfiguredContextSize(options: ProvideLanguageModelChatResponseOptions): number | undefined {
    const config = options as ProvideLanguageModelChatResponseOptions & {
      configuration?: Record<string, unknown>;
      modelConfiguration?: Record<string, unknown>;
    };
    return this.parseContextWindowTokens(config.configuration?.contextSize ?? config.modelConfiguration?.contextSize);
  }

  private async truncateMessagesToContext(
    messages: readonly LanguageModelChatRequestMessage[],
    model: vscode.LanguageModelChatInformation,
    token: CancellationToken
  ): Promise<readonly LanguageModelChatRequestMessage[]> {
    const maxInputTokens = model.maxInputTokens || DEFAULT_CONTEXT_LENGTH;
    if (messages.length <= 1) {
      return messages;
    }

    const tokenCounts = await Promise.all(messages.map((message) => prepareTokenCount(model, message, token)));
    const totalTokens = tokenCounts.reduce((sum, count) => sum + count, 0);
    if (totalTokens <= maxInputTokens) {
      return messages;
    }

    const firstMessage = messages[0];
    const hasSystemHead = firstMessage && mapRole(firstMessage) === "system";
    const kept: LanguageModelChatRequestMessage[] = [];
    let usedTokens = 0;

    if (hasSystemHead) {
      kept.push(firstMessage);
      usedTokens += tokenCounts[0] ?? 0;
    }

    const suffix: LanguageModelChatRequestMessage[] = [];
    const startIndex = hasSystemHead ? 1 : 0;
    for (let i = messages.length - 1; i >= startIndex; i--) {
      const count = tokenCounts[i] ?? 0;
      if (suffix.length > 0 && usedTokens + count > maxInputTokens) {
        break;
      }
      suffix.push(messages[i]);
      usedTokens += count;
    }

    suffix.reverse();
    const truncated = hasSystemHead ? [...kept, ...suffix] : suffix;
    const droppedCount = messages.length - truncated.length;
    if (droppedCount > 0) {
      this.output.appendLine(
        `Truncated ${droppedCount} message(s) for model=${model.id}; estimatedTokens=${totalTokens}, maxInputTokens=${maxInputTokens}.`
      );
    }
    return truncated.length > 0 ? truncated : messages.slice(-1);
  }

  private async fetchStreamingResponseBody(
    apiType: ZenMuxApiType,
    apiKey: string,
    requestUrl: string,
    requestBody: unknown,
    label: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await executeWithRetry(async () => {
      const res = await fetch(requestUrl, {
        method: "POST",
        headers: this.getRequestHeaders(apiType, apiKey, requestBody),
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const serverRequestId = this.getServerRequestId(res.headers, errorText);
        const requestIdText = serverRequestId ? ` serverRequestId=${serverRequestId}` : "";
        const msg = `[${label}] API error response status=${res.status} statusText=${res.statusText}${requestIdText} body=${errorText}`;
        try { this.output.appendLine(msg); } catch { console.error(msg); }
        throw new Error(
          `[${label}] API error: [${res.status}] ${res.statusText}${requestIdText}${errorText ? `\n${errorText}` : ""}`
        );
      }

      return res;
    }, createRetryConfig());

    if (!response.body) {
      const msg = `[${label}] No response body from API`;
      try { this.output.appendLine(msg); } catch { console.error(msg); }
      throw new Error(msg);
    }

    return response.body;
  }

  private getServerRequestId(headers: Headers, bodyText: string): string | undefined {
    for (const headerName of ["x-zenmux-requestid", "x-request-id", "request-id", "x-correlation-id", "x-github-request-id", "cf-ray"]) {
      const value = headers.get(headerName);
      if (value) {
        return value;
      }
    }

    if (!bodyText) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(bodyText) as unknown;
      return this.findRequestIdInErrorBody(parsed);
    } catch {
      return undefined;
    }
  }

  private findRequestIdInErrorBody(value: unknown): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    for (const key of ["request_id", "requestID", "requestId", "id"]) {
      const requestId = record[key];
      if (typeof requestId === "string" && requestId.trim()) {
        return requestId;
      }
    }

    for (const nestedValue of Object.values(record)) {
      const requestId = this.findRequestIdInErrorBody(nestedValue);
      if (requestId) {
        return requestId;
      }
    }
    return undefined;
  }

  private getBaseUrlForApiType(config: vscode.WorkspaceConfiguration, apiType: ZenMuxApiType): string {
    switch (apiType) {
      case "messages":
        return config.get<string>("zenmux.anthropic.baseUrl", "https://zenmux.ai/api/anthropic");
      default:
        return config.get<string>("zenmux.baseUrl", "https://zenmux.ai/api/v1");
    }
  }

  private getRequestHeaders(apiType: ZenMuxApiType, apiKey: string, requestBody: unknown): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };

    if (apiType === "messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-beta"] = this.getAnthropicBetaHeader(requestBody);
      return headers;
    }

    headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  private getAnthropicBetaHeader(requestBody: unknown): string {
    const betas = ["interleaved-thinking-2025-05-14"];
    if (this.hasAnthropicTools(requestBody)) {
      betas.push("advanced-tool-use-2025-11-20");
    }
    if (this.hasOneHourCacheControl(requestBody)) {
      betas.push("extended-cache-ttl-2025-04-11");
    }
    return betas.join(",");
  }

  private getAnthropicCacheTtl(config: vscode.WorkspaceConfiguration): "5m" | "1h" {
    return config.get<"5m" | "1h">("zenmux.anthropic.cacheTtl", "5m") === "1h" ? "1h" : "5m";
  }

  private hasAnthropicTools(requestBody: unknown): boolean {
    if (!requestBody || typeof requestBody !== "object") {
      return false;
    }
    const tools = (requestBody as { tools?: unknown }).tools;
    return Array.isArray(tools) && tools.length > 0;
  }

  private hasOneHourCacheControl(value: unknown): boolean {
    if (!value || typeof value !== "object") {
      return false;
    }
    if ((value as { cache_control?: { ttl?: unknown } }).cache_control?.ttl === "1h") {
      return true;
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.hasOneHourCacheControl(item));
    }
    return Object.values(value).some((item) => this.hasOneHourCacheControl(item));
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
