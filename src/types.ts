/**
 * A single underlying provider (e.g., together, groq) for a model.
 */
export interface HFProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
}

/**
 * A model entry returned by the Hugging Face router models endpoint.
 */
export interface HFArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

export interface HFModelItem {
	id: string;
	object?: string;
	created?: number;
	owned_by: string;
	configId?: string;
	displayName?: string;
	baseUrl?: string;
	providers?: HFProvider[];
	architecture?: HFArchitecture;
	context_length?: number;
	vision?: boolean;
	max_tokens?: number;
	// OpenAI new standard parameter
	max_completion_tokens?: number;
	reasoning_effort?: string;
	enable_thinking?: boolean;
	thinking_budget?: number;
	// New thinking configuration for Zai provider
	thinking?: ThinkingConfig;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	temperature?: number | null;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	top_p?: number | null;
	top_k?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: ReasoningConfig;
	/**
	 * Optional family specification for the model. This allows users to specify
	 * the model family (e.g., "gpt-4", "claude-3", "gemini") to enable family-specific
	 * optimizations and behaviors in the Copilot extension. If not specified,
	 * defaults to "oai-compatible".
	 */
	family?: string;

	/**
	 * Extra configuration parameters that can be used for custom functionality.
	 * This allows users to add any additional parameters they might need
	 * without modifying the core interface.
	 */
	extra?: Record<string, unknown>;

	/**
	 * Custom HTTP headers to be sent with every request to this model's provider.
	 * These headers will be merged with the default headers (Authorization, Content-Type, User-Agent).
	 * Example: { "X-API-Version": "v1", "X-Custom-Header": "value" }
	 */
	headers?: Record<string, string>;

	/**
	 * Whether to include reasoning_content in assistant messages sent to the API.
	 * Support deepseek-v3.2 or others.
	 */
	include_reasoning_in_request?: boolean;

	/**
	 * API mode: "openai" for OpenAI-compatible API, "ollama" for Ollama native API.
	 * Default is "openai".
	 */
	apiMode?: "openai" | "ollama" | "anthropic";
}

/**
 * OpenRouter reasoning configuration
 */
export interface ReasoningConfig {
	effort?: string;
	exclude?: boolean;
	max_tokens?: number;
	enabled?: boolean;
}

/**
 * Supplemental model info from the Hugging Face hub API.
 */
// Deprecated: extra model info was previously fetched from the hub API
export interface HFExtraModelInfo {
	id: string;
	pipeline_tag?: string;
}

export interface ZenMuxModelInfo {
	all_tokens?: number;
	author?: string;
	context_length: number;
	description?: string;
	display_endpoint_id?: string;
	endpoint_slug?: string;
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	display_name?: string;
	input_modalities: string | string[];
	latency: number | null;
	max_completion_tokens?: number;
	model_endpoint_visible?: number;
	model_visible?: number;
	name?: string;
	output_modalities: string | string[];
	pricing_completion?: string;
	pricing_prompt?: string;
	publish_time?: string;
	slug?: string;
	suitable_api?: string;
	supported_parameters?: string | string[];
	supports_reasoning?: number;
	supports_streaming?: number | boolean;
	supports_tool_parameters?: number | boolean;
	capabilities?: {
		reasoning?: boolean;
		tools?: boolean;
		tool_calling?: boolean;
	};
	adapters?: ZenMuxModelAdapter[];
	endpoints?: ZenMuxModelEndpoint[];
	throughput: number | null;
	token_week?: number;
	iconUrl?: string;
	isFree?: boolean;
	providerIcons?: string[];
	uptimeHh?: Record<string, number>;
}

export interface ZenMuxModelAdapter {
	api?: string;
	supported_parameters?: string | string[];
	builtin_tools?: string[];
}

export interface ZenMuxModelEndpoint {
	endpoint_slug?: string;
	provider_slug?: string;
	supported_parameters?: string | string[];
	adapters?: ZenMuxModelAdapter[];
}

export interface ZenMuxModelResponse {
	success?: boolean;
	object?: string;
	data: ZenMuxModelInfo[];
}

/**
 * Response envelope for the router models listing.
 */
export interface HFModelsResponse {
	object: string;
	data: HFModelItem[];
}

/**
 * Thinking configuration for Zai provider
 */
export interface ThinkingConfig {
	type?: string;
}

/**
 * Retry configuration for rate limiting
 */
export interface RetryConfig {
	enabled?: boolean;
	max_attempts?: number;
	interval_ms?: number;
	status_codes?: number[];
}
