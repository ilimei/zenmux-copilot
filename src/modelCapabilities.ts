import * as vscode from "vscode";
import { ZenMuxModelInfo } from "./types";

export type ZenMuxAdapterProtocol = "anthropic" | "vertex" | "openai";
export type ZenMuxApiType = "chat-completions" | "messages" | "responses" | "gemini";

export interface NormalizedZenMuxModel {
	model: ZenMuxModelInfo;
	apis: Set<string>;
	inputModalities: Set<string>;
	outputModalities: Set<string>;
	parameters: Set<string>;
	adapterProtocol: ZenMuxAdapterProtocol;
	apiType: ZenMuxApiType;
	selectedSupportedParameters?: string | string[];
	isChatModel: boolean;
	supportsTools: boolean;
	supportsReasoning: boolean;
	capabilities: vscode.LanguageModelChatCapabilities;
}

const CHAT_APIS = new Set(["chat.completions", "messages", "responses", "gemini"]);
const IMPLEMENTED_API_TYPES = new Set<ZenMuxApiType>(["chat-completions", "messages"]);
const TOOL_CAPABLE_ENDPOINTS = [
	"/chat-completions",
	"/messages",
	"/gemini",
	"/responses",
];

export function normalizeZenMuxModel(model: ZenMuxModelInfo): NormalizedZenMuxModel {
	const apis = parseList(model.suitable_api);
	const inputModalities = parseList(model.input_modalities);
	const outputModalities = parseList(model.output_modalities);
	const apiType = inferApiType(model, apis);
	const selectedSupportedParameters = getSupportedParametersForApiType(model, apiType);
	const parameters = parseList(selectedSupportedParameters);
	const adapterProtocol = inferAdapterProtocol(model, apiType);
	const hasChatApi = apis.size === 0 || [...apis].some((api) => CHAT_APIS.has(api));
	const isChatModel = IMPLEMENTED_API_TYPES.has(apiType) && hasChatApi && outputModalities.has("text");
	const supportsTools = inferToolSupport(model, parameters, isChatModel);
	const capabilities: vscode.LanguageModelChatCapabilities = {
		imageInput: inputModalities.has("image"),
		toolCalling: supportsTools,
	};

	return {
		model,
		apis,
		inputModalities,
		outputModalities,
		parameters,
		adapterProtocol,
		apiType,
		selectedSupportedParameters,
		isChatModel,
		supportsTools,
		supportsReasoning: modelSupportsReasoning(model),
		capabilities,
	};
}

export function parseList(value: string | string[] | undefined | null): Set<string> {
	if (Array.isArray(value)) {
		return new Set(value.map((item) => item.trim().toLowerCase()).filter(Boolean));
	}
	return new Set(
		(value ?? "")
			.split(",")
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean)
	);
}

export function supportsParameter(supportedParameters: string | string[] | undefined, parameter: string): boolean {
	return parseList(supportedParameters).has(parameter.toLowerCase());
}

export function modelSupportsTools(model: NormalizedZenMuxModel | undefined): boolean {
	return model?.supportsTools ?? false;
}

export function modelSupportsReasoning(model: NormalizedZenMuxModel | ZenMuxModelInfo | undefined): boolean {
	if (!model) {
		return false;
	}
	if ("supportsReasoning" in model) {
		return model.supportsReasoning;
	}
	return Boolean(model.capabilities?.reasoning) || (model.supports_reasoning ?? 0) > 0;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Read the user-selected reasoning effort from the per-model configuration
 * (set via the model picker thanks to `configurationSchema`).
 * Returns undefined when unset or set to "auto" (provider/gateway default).
 */
export function getConfiguredReasoningEffort(options: vscode.ProvideLanguageModelChatResponseOptions): ReasoningEffort | undefined {
	const config = (options as { modelConfiguration?: Record<string, unknown> }).modelConfiguration;
	const value = config?.reasoningEffort;
	return REASONING_EFFORTS.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined;
}

/**
 * Map a reasoning effort to a thinking token budget, following ZenMux's tiers
 * (low: 20%, medium: 50%, high: 80%, xhigh: 95%, max: all of the output budget).
 * The result is clamped so that 1024 <= budget < maxOutputTokens (Anthropic requirements).
 */
export function computeThinkingBudget(effort: ReasoningEffort, maxOutputTokens: number): number {
	const upperBound = Math.max(1024, maxOutputTokens - 1024);
	if (effort === "max") {
		return upperBound;
	}
	const ratio = effort === "low" ? 0.2 : effort === "medium" ? 0.5 : effort === "high" ? 0.8 : effort === "xhigh" ? 0.95 : 0;
	const raw = effort === "minimal" ? 1024 : Math.floor(maxOutputTokens * ratio);
	return Math.min(Math.max(1024, raw), upperBound);
}

/**
 * Model-picker configuration schemas for reasoning-capable models, letting the
 * user pick a thinking depth.
 *
 * Anthropic (Claude) models follow the official tiers low/medium/high/xhigh/max
 * with a default of high. Other protocols keep an "auto" tier that defers to the
 * provider/gateway default.
 */
const ANTHROPIC_REASONING_EFFORT_CONFIGURATION_SCHEMA: vscode.LanguageModelConfigurationSchema = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Thinking Effort",
			enum: ["low", "medium", "high", "xhigh", "max"],
			enumItemLabels: ["Low", "Medium", "High", "Xhigh", "Max"],
			default: "high",
			description: "Reasoning depth (thinking budget) used by this model.",
			group: "navigation",
		},
	},
};

const DEFAULT_REASONING_EFFORT_CONFIGURATION_SCHEMA: vscode.LanguageModelConfigurationSchema = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Thinking Effort",
			enum: ["auto", "minimal", "low", "medium", "high", "xhigh"],
			enumItemLabels: ["Auto", "Minimal", "Low", "Medium", "High", "Extra High"],
			default: "auto",
			description: "Reasoning depth (thinking budget) used by this model.",
			group: "navigation",
		},
	},
};

export function getReasoningConfigurationSchema(adapterProtocol: ZenMuxAdapterProtocol): vscode.LanguageModelConfigurationSchema {
	return adapterProtocol === "anthropic"
		? ANTHROPIC_REASONING_EFFORT_CONFIGURATION_SCHEMA
		: DEFAULT_REASONING_EFFORT_CONFIGURATION_SCHEMA;
}

export function buildCustomEndpointUrl(baseUrl: string, apiType: ZenMuxApiType): string {
	if (isCompleteEndpointUrl(baseUrl)) {
		return baseUrl;
	}

	const trimmedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const apiPath = getApiPath(apiType);
	if (/\/v\d+$/.test(trimmedBaseUrl)) {
		return `${trimmedBaseUrl}${apiPath}`;
	}
	return `${trimmedBaseUrl}/v1${apiPath}`;
}

function isCompleteEndpointUrl(url: string): boolean {
	return url.includes("/responses") || url.includes("/chat/completions") || url.includes("/messages") || url.includes("/gemini");
}

function getApiPath(apiType: ZenMuxApiType): string {
	switch (apiType) {
		case "responses":
			return "/responses";
		case "messages":
			return "/messages";
		case "gemini":
			return "/gemini";
		default:
			return "/chat/completions";
	}
}

function inferApiType(model: ZenMuxModelInfo, apis: Set<string>): ZenMuxApiType {
	const endpointSlug = (model.endpoint_slug ?? "").toLowerCase();
	if (endpointSlug.endsWith("/messages")) {
		return "messages";
	}
	if (endpointSlug.endsWith("/responses")) {
		return chooseImplementedApiType(apis) ?? "responses";
	}
	if (endpointSlug.endsWith("/gemini")) {
		return chooseImplementedApiType(apis) ?? "gemini";
	}
	if (endpointSlug.endsWith("/chat-completions") || endpointSlug.endsWith("/chat/completions")) {
		return "chat-completions";
	}

	if (apis.has("chat.completions")) {
		return "chat-completions";
	}
	if (apis.has("messages")) {
		return "messages";
	}
	if (apis.has("responses")) {
		return "responses";
	}
	if (apis.has("gemini")) {
		return "gemini";
	}
	return "chat-completions";
}

function chooseImplementedApiType(apis: Set<string>): ZenMuxApiType | undefined {
	if (apis.has("chat.completions")) {
		return "chat-completions";
	}
	if (apis.has("messages")) {
		return "messages";
	}
	return undefined;
}

function inferAdapterProtocol(model: ZenMuxModelInfo, apiType: ZenMuxApiType): ZenMuxAdapterProtocol {
	if (apiType === "messages") {
		return "anthropic";
	}
	if (apiType === "gemini") {
		return "vertex";
	}
	const provider = (model.owned_by ?? model.author ?? "").toLowerCase();
	const modelId = model.id.toLowerCase();
	if (provider === "anthropic" || modelId.startsWith("anthropic/")) {
		return "anthropic";
	}
	if (provider === "google" || provider === "google-vertex" || modelId.startsWith("google/")) {
		return "vertex";
	}
	return "openai";
}

function getSupportedParametersForApiType(model: ZenMuxModelInfo, apiType: ZenMuxApiType): string | string[] | undefined {
	const apiName = apiType === "chat-completions" ? "chat.completions" : apiType;
	const endpointMatch = findEndpointForApiType(model, apiType);
	const adapterMatch = endpointMatch?.adapters?.find((adapter) => adapter.api === apiName)
		?? model.adapters?.find((adapter) => adapter.api === apiName);

	return adapterMatch?.supported_parameters ?? endpointMatch?.supported_parameters ?? model.supported_parameters;
}

function findEndpointForApiType(model: ZenMuxModelInfo, apiType: ZenMuxApiType) {
	const apiName = apiType === "chat-completions" ? "chat.completions" : apiType;
	const currentEndpointSlug = (model.endpoint_slug ?? "").toLowerCase();
	const endpointForCurrentSlug = model.endpoints?.find((endpoint) => {
		const endpointSlug = (endpoint.endpoint_slug ?? "").toLowerCase();
		return endpointSlug === currentEndpointSlug && hasEndpointApi(endpoint, apiName);
	});
	if (endpointForCurrentSlug) {
		return endpointForCurrentSlug;
	}

	return model.endpoints?.find((endpoint) => {
		const endpointSlug = (endpoint.endpoint_slug ?? "").toLowerCase();
		return (endpointSlug.endsWith(`/${apiType}`) || endpointSlug.endsWith(`/${apiName}`)) && hasEndpointApi(endpoint, apiName);
	});
}

function hasEndpointApi(endpoint: { adapters?: Array<{ api?: string }> }, apiName: string): boolean {
	return !endpoint.adapters?.length || endpoint.adapters.some((adapter) => adapter.api === apiName);
}

function inferToolSupport(model: ZenMuxModelInfo, parameters: Set<string>, isChatModel: boolean): boolean {
	if (!isChatModel) {
		return false;
	}

	if (parameters.has("tools") || parameters.has("tool_choice")) {
		return true;
	}

	if (parameters.size > 0) {
		return false;
	}

	if (model.supports_tool_parameters === true || model.supports_tool_parameters === 1 || model.capabilities?.tools || model.capabilities?.tool_calling) {
		return true;
	}

	const endpointSlug = (model.endpoint_slug ?? "").toLowerCase();
	if (endpointSlug) {
		return TOOL_CAPABLE_ENDPOINTS.some((suffix) => endpointSlug.endsWith(suffix));
	}
	return true;
}
