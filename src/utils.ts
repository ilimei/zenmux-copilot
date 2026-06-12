import * as vscode from "vscode";
import { RetryConfig, ZenMuxModelInfo, ZenMuxModelResponse } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";
import { modelSupportsTools, supportsParameter as supportsModelParameter } from "./modelCapabilities";

const ZENMUX_MODELS_URL = "https://zenmux.ai/api/frontend/model/available/list?sort=newest";

/**
 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
 * @param silent If true, do not prompt the user.
 * @param secrets vscode.SecretStorage
 */
export async function ensureApiKey(silent: boolean, secrets: vscode.SecretStorage): Promise<string | undefined> {
	// Fall back to generic API key
	let apiKey = await secrets.get("zenmux.apiKey");

	if (!apiKey && !silent) {
		const entered = await vscode.window.showInputBox({
			title: "ZenMux API Key",
			prompt: "Enter your ZenMux API key",
			ignoreFocusOut: true,
			password: true,
		});
		if (entered && entered.trim()) {
			apiKey = entered.trim();
			await secrets.store("zenmux.apiKey", apiKey);
		}
	}
	return apiKey;
}


/**
 * Fetch the list of models and supplementary metadata from ZenMux.
 */
export async function fetchModels(apiKey: string, userAgent: string, output: vscode.OutputChannel): Promise<{ models: ZenMuxModelInfo[] }> {
	const modelsList = (async () => {
		const resp = await fetch(ZENMUX_MODELS_URL, {
			method: "GET",
			headers: {
				"User-Agent": userAgent,
			},
		});
		if (!resp.ok) {
			let text = "";
			try {
				text = await resp.text();
			} catch (error: any) {
				if (error instanceof Error) {
					output.appendLine(`Error reading response text: ${error.message}`);
					error.stack && output.appendLine(error.stack);
				} else {
					output.appendLine(`Unknown error reading response text: ${String(error)}`);
				}
				console.error("[ZenMux Model Provider] Failed to read response text", error);
			}
			const err = new Error(
				`Failed to fetch ZenMux models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`
			);
			console.error("[ZenMux Model Provider] Failed to fetch ZenMux models", err);
			throw err;
		}
		const parsed = (await resp.json()) as ZenMuxModelResponse;
		return parsed.data ?? [];
	})();

	try {
		const models = await modelsList;
		return { models };
	} catch (err) {
		if (err instanceof Error) {
			output.appendLine(`Failed to fetch ZenMux models: ${err.message}`);
			err.stack && output.appendLine(err.stack);
		} else {
			output.appendLine(`Failed to fetch ZenMux models: ${String(err)}`);
		}
		console.error("[ZenMux Model Provider] Failed to fetch ZenMux models", err);
		throw err;
	}
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions only when the model supports tools.
 * @param options Request options containing tools and toolMode.
 * @param supportedParameters Comma-separated model parameter list from the ZenMux models API.
 */
export function convertToolsToOpenAIWithSupport(
	options: vscode.ProvideLanguageModelChatResponseOptions,
	model?: ZenMuxModelInfo
): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}
	if (!modelSupportsTools(model)) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[ZenMux Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Check whether a comma-separated model capability list includes a parameter.
 */
export function supportsParameter(supportedParameters: string | string[] | undefined, parameter: string): boolean {
	return supportsModelParameter(supportedParameters, parameter);
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("zenmux.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const intervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			console.error(
				`[ZenMux Model Provider] Retryable error detected, retrying in ${intervalMs}ms (attempt ${attempt + 1}/${maxAttempts})`
			);

			// Wait for the specified interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	throw lastError || new Error("Retry failed");
}
