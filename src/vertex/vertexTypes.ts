/**
 * Vertex AI (Google Cloud) API message format
 * @see https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference/gemini
 */

export type VertexRole = "user" | "model";

export interface VertexTextPart {
	text: string;
}

export interface VertexInlineDataPart {
	inlineData: {
		mimeType: string;
		data: string;
	};
}

export interface VertexFunctionCallPart {
	functionCall: {
		name: string;
		args: Record<string, unknown>;
	};
}

export interface VertexFunctionResponsePart {
	functionResponse: {
		name: string;
		response: {
			name: string;
			content: unknown;
		};
	};
}

export interface VertexThinkingPart {
	thought: {
		thought: string;
	};
}

export type VertexPart =
	| VertexTextPart
	| VertexInlineDataPart
	| VertexFunctionCallPart
	| VertexFunctionResponsePart
	| VertexThinkingPart;

export interface VertexContent {
	role: VertexRole;
	parts: VertexPart[];
}

export interface VertexRequestBody {
	contents: VertexContent[];
	systemInstruction?: {
		parts: VertexTextPart[];
	};
	generationConfig?: {
		temperature?: number;
		topP?: number;
		topK?: number;
		candidateCount?: number;
		maxOutputTokens?: number;
		stopSequences?: string[];
		responseMimeType?: string;
		thinkingConfig?: {
			thinkingBudget?: number;
			includeThoughts?: boolean;
		};
	};
	safetySettings?: VertexSafetySettings[];
	tools?: VertexToolDeclaration[];
	toolConfig?: VertexToolConfig;
}

export interface VertexSafetySettings {
	category: string;
	threshold: string;
}

export interface VertexToolDeclaration {
	functionDeclarations: VertexFunctionDeclaration[];
}

export interface VertexFunctionDeclaration {
	name: string;
	description?: string;
	parameters?: object;
}

export interface VertexToolConfig {
	functionCallingConfig: {
		mode: "AUTO" | "ANY" | "NONE";
		allowedFunctionNames?: string[];
	};
}

export interface VertexCandidate {
	content: VertexContent;
	finishReason?: string;
	safetyRatings?: {
		category: string;
		probability: string;
	}[];
	citationMetadata?: {
		citationSources: {
			startIndex: number;
			endIndex: number;
			uri?: string;
			license?: string;
		}[];
	};
}

export interface VertexStreamChunk {
	candidates?: VertexCandidate[];
	usageMetadata?: {
		promptTokenCount: number;
		candidatesTokenCount: number;
		totalTokenCount: number;
	};
	modelVersion?: string;
}

export interface VertexErrorResponse {
	error: {
		code: number;
		message: string;
		status: string;
		details?: unknown[];
	};
}
