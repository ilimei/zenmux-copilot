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
 * Retry configuration for rate limiting
 */
export interface RetryConfig {
	enabled?: boolean;
	max_attempts?: number;
	interval_ms?: number;
	status_codes?: number[];
}
