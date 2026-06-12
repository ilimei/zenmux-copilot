import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem, ZenMuxModelInfo } from "../types";

import type {
	VertexRequestBody,
	VertexContent,
	VertexPart,
	VertexStreamChunk,
	VertexFunctionCallPart,
	VertexFunctionResponsePart,
} from "./vertexTypes";

import { isImageMimeType, isToolResultPart, collectToolResultText, convertToolsToOpenAIWithSupport, mapRole } from "../utils";
import { computeThinkingBudget, getConfiguredReasoningEffort, modelSupportsReasoning } from "../modelCapabilities";

import { CommonApi } from "../commonApi";

export class VertexApi extends CommonApi {
	private _systemContent: string | undefined;

	constructor() {
		super();
	}

	/**
	 * Convert VS Code chat messages to Vertex AI message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Vertex AI-compatible contents array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): VertexContent[] {
		const out: VertexContent[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const parts: VertexPart[] = [];
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: VertexFunctionCallPart[] = [];
			const toolResults: VertexFunctionResponsePart[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (part.value.trim().length === 0) {
						continue;
					}
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({
						functionCall: {
							name: part.name,
							args: (part.input as Record<string, unknown>) ?? {},
						},
					});
				} else if (isToolResultPart(part)) {
					const toolName = (part as { name?: string }).name ?? "unknown_tool";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({
						functionResponse: {
							name: toolName,
							response: {
								name: toolName,
								content,
							},
						},
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			// Handle system messages separately (Vertex uses systemInstruction field)
			if (role === "system") {
				if (textParts.length > 0) {
					this._systemContent = textParts.join("\n");
				}
				continue;
			}

			// Convert role: assistant -> model for Vertex AI
			const vertexRole: "user" | "model" = role === "assistant" ? "model" : "user";

			// Add text content
			if (textParts.length > 0) {
				parts.push({
					text: textParts.join("\n"),
				});
			}

			// Add image content
			for (const imagePart of imageParts) {
				const base64Data = Buffer.from(imagePart.data).toString("base64");
				parts.push({
					inlineData: {
						mimeType: imagePart.mimeType,
						data: base64Data,
					},
				});
			}

			// Add thinking content for model messages
			if (vertexRole === "model" && thinkingParts.length > 0 && modelConfig.includeReasoningInRequest) {
				parts.push({
					thought: {
						thought: thinkingParts.join("\n"),
					},
				});
			}

			// Add tool calls for model messages
			for (const toolCall of toolCalls) {
				parts.push(toolCall);
			}

			// For tool results, they should be added to user messages
			if (vertexRole === "user" && toolResults.length > 0) {
				for (const toolResult of toolResults) {
					parts.push(toolResult);
				}
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				console.warn("[Vertex Provider] Tool results found in non-user message, ignoring");
			}

			// Only add message if we have parts
			if (parts.length > 0) {
				out.push({
					role: vertexRole,
					parts,
				});
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: any,
		um: ZenMuxModelInfo | undefined,
		options: ProvideLanguageModelChatResponseOptions
	): any {
		const vrb = rb as VertexRequestBody;
		// Initialize generationConfig if not present
		if (!vrb.generationConfig) {
			vrb.generationConfig = {};
		}

		// Set maxOutputTokens
		// if (um?.max_tokens !== undefined) {
		// 	vrb.generationConfig.maxOutputTokens = um.max_tokens;
		// }

		// Add system instruction if we extracted it
		if (this._systemContent) {
			vrb.systemInstruction = {
				parts: [{ text: this._systemContent }],
			};
		}

		// Thinking depth selected by the user in the model picker.
		const reasoningEffort = getConfiguredReasoningEffort(options);
		if (reasoningEffort && modelSupportsReasoning(um)) {
			const maxOutputTokens = vrb.generationConfig.maxOutputTokens ?? um?.max_completion_tokens ?? 8192;
			vrb.generationConfig.thinkingConfig = {
				thinkingBudget: computeThinkingBudget(reasoningEffort, maxOutputTokens),
			};
		}

		// Add temperature
		// const oTemperature = options.modelOptions?.temperature ?? 0;
		// const temperature = um?.temperature ?? oTemperature;
		// vrb.generationConfig.temperature = temperature;
		// if (um && um.temperature === null) {
		// 	delete vrb.generationConfig.temperature;
		// }

		// Add topP if configured
		// if (um?.top_p !== undefined && um.top_p !== null) {
		// 	vrb.generationConfig.topP = um.top_p;
		// }

		// Add topK if configured
		// if (um?.top_k !== undefined) {
		// 	vrb.generationConfig.topK = um.top_k;
		// }

		// Add tools configuration
		const toolConfig = convertToolsToOpenAIWithSupport(options, um);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Vertex format
			vrb.tools = [
				{
					functionDeclarations: toolConfig.tools.map((tool) => ({
						name: tool.function.name,
						description: tool.function.description,
						parameters: tool.function.parameters,
					})),
				},
			];
		}

		// Add toolConfig (function calling config)
		if (toolConfig.tool_choice) {
			if (!vrb.toolConfig) {
				vrb.toolConfig = {
					functionCallingConfig: {
						mode: "AUTO",
					},
				};
			}

			if (toolConfig.tool_choice === "auto") {
				vrb.toolConfig.functionCallingConfig.mode = "AUTO";
			} else if (typeof toolConfig.tool_choice === "object" && toolConfig.tool_choice.type === "function") {
				vrb.toolConfig.functionCallingConfig.mode = "ANY";
				vrb.toolConfig.functionCallingConfig.allowedFunctionNames = [toolConfig.tool_choice.function.name];
			}
		}

		// Process extra configuration parameters
		// if (um?.extra && typeof um.extra === "object") {
		// 	// Add all extra parameters directly to the request body
		// 	for (const [key, value] of Object.entries(um.extra)) {
		// 		if (value !== undefined) {
		// 			(vrb as unknown as Record<string, unknown>)[key] = value;
		// 		}
		// 	}
		// }

		return vrb;
	}

	/**
	 * Process Vertex AI streaming response (SSE format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim() === "") {
						continue;
					}
					if (!line.startsWith("data: ")) {
						continue;
					}

					const data = line.slice(6);
					if (data === "[DONE]") {
						// Flush any incomplete tool calls
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						continue;
					}

					try {
						const chunk: VertexStreamChunk = JSON.parse(data);
						await this.processVertexChunk(chunk, progress);
					} catch (e) {
						console.error("[Vertex Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);
		}
	}

	/**
	 * Process a single Vertex AI streaming chunk.
	 * @param chunk Parsed Vertex stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processVertexChunk(
		chunk: VertexStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		// Vertex AI returns candidates array
		if (!chunk.candidates || chunk.candidates.length === 0) {
			return;
		}

		// Process first candidate (Vertex typically returns one candidate in streaming)
		const candidate = chunk.candidates[0];
		if (!candidate.content || !candidate.content.parts) {
			return;
		}

		// Process each part in the candidate's content
		for (const part of candidate.content.parts) {
			if ("text" in part && part.text) {
				// Emit text content
				progress.report(new vscode.LanguageModelTextPart(part.text));
				this._hasEmittedAssistantText = true;
			} else if ("thought" in part && part.thought && part.thought.thought) {
				// Buffer thinking content
				this.bufferThinkingContent(part.thought.thought, progress);
			} else if ("functionCall" in part && part.functionCall) {
				// Handle tool call
				// Emit whitespace hint if first tool call after text
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				const name = part.functionCall.name;
				const parameters = part.functionCall.args || {};

				progress.report(new vscode.LanguageModelToolCallPart(id, name, parameters));
			}
		}

		// Check for finish reason to end thinking if present
		if (candidate.finishReason) {
			this.reportEndThinking(progress);
		}
	}
}
