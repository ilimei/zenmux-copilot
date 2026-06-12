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
	AnthropicMessage,
	AnthropicRequestBody,
	AnthropicContentBlock,
	AnthropicToolUseBlock,
	AnthropicToolResultBlock,
	AnthropicStreamChunk,
} from "./anthropicTypes";

import { isImageMimeType, isToolResultPart, collectToolResultText, convertToolsToOpenAIWithSupport, supportsParameter, mapRole } from "../utils";
import { computeThinkingBudget, getConfiguredReasoningEffort, modelSupportsReasoning } from "../modelCapabilities";

import { CommonApi } from "../commonApi";

export class AnthropicApi extends CommonApi {
	private _systemContent: string | undefined;

	constructor() {
		super();
	}

	/**
	 * Convert VS Code chat messages to Anthropic message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Anthropic-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean; supportParameters: string; }
	): AnthropicMessage[] {
		const out: AnthropicMessage[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: AnthropicToolUseBlock[] = [];
			const toolResults: AnthropicToolResultBlock[] = [];
			const thinkingParts: { thinking: string; signature?: string }[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (part.value.trim().length === 0) {
						continue;
					}
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					toolCalls.push({
						type: "tool_use",
						id,
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					});
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({
						type: "tool_result",
						tool_use_id: callId,
						content,
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					const metadata = (part as { metadata?: { signature?: unknown } }).metadata;
					thinkingParts.push({
						thinking: content,
						signature: typeof metadata?.signature === "string" ? metadata.signature : undefined,
					});
				}
			}

			// Handle system messages separately (Anthropic uses top-level system field)
			if (role === "system") {
				if (textParts.length > 0) {
					this._systemContent = textParts.join("\n");
				}
				continue;
			}

			// Build content blocks for user/assistant messages
			const contentBlocks: AnthropicContentBlock[] = [];

			// Add text content
			if (textParts.length > 0) {
				contentBlocks.push({
					type: "text",
					text: textParts.join("\n"),
				});
			}

			// Add image content
			for (const imagePart of imageParts) {
				const base64Data = Buffer.from(imagePart.data).toString("base64");
				contentBlocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: imagePart.mimeType,
						data: base64Data,
					},
				});
			}

			// Add thinking content for assistant messages
			if (role === "assistant" && thinkingParts.length > 0 && modelConfig.includeReasoningInRequest) {
				const thinking = thinkingParts.map((part) => part.thinking).join("\n");
				const signature = [...thinkingParts].reverse().find((part) => part.signature)?.signature;
				contentBlocks.push({
					type: "thinking",
					thinking,
					...(signature ? { signature } : {}),
				});
			}

			// Add tool calls for assistant messages
			for (const toolCall of toolCalls) {
				contentBlocks.push(toolCall);
			}

			// For tool results, they should be added to user messages
			// We'll add them to the current message if it's a user message
			if (role === "user" && toolResults.length > 0) {
				for (const toolResult of toolResults) {
					contentBlocks.push(toolResult);
				}
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				console.warn("[Anthropic Provider] Tool results found in non-user message, ignoring");
			}

			// Only add message if we have content blocks
			if (contentBlocks.length > 0) {
				out.push({
					role,
					content: contentBlocks,
				});
			}
		}

		const sanitized = this.sanitizeToolUsePairs(out);

		// 为关键消息添加缓存控制。Anthropic 最多支持 4 个缓存断点：
		// 1. 优先给上下文消息打断点；2. 始终给最后一条消息打断点；3. 剩余配额给长文本。
		const systemTakesCache = !!this._systemContent;
		const maxMessagesWithCache = systemTakesCache ? 3 : 4;
		const indicesToCache = this.selectCacheBreakpoints(sanitized, maxMessagesWithCache);

		// 3. 应用缓存控制
		const messagesWithCache = sanitized.map((msg, index) => {
			if (indicesToCache.has(index) && Array.isArray(msg.content) && msg.content.length > 0) {
				const contentBlocks = [...msg.content];
				// 尝试在最后一个支持缓存的 block 上添加标记
				// 注意：Thinking block 目前可能不支持，所以要找到最后一个支持的类型
				let targetBlockIndex = -1;
				for (let i = contentBlocks.length - 1; i >= 0; i--) {
					const block = contentBlocks[i];
					if (
						block.type === "text" ||
						block.type === "image"
					) {
						targetBlockIndex = i;
						break;
					}
				}

				if (targetBlockIndex !== -1) {
					const targetBlock = contentBlocks[targetBlockIndex];
					(targetBlock as any).cache_control = { type: "ephemeral" };
				}

				return { ...msg, content: contentBlocks };
			}
			return msg;
		});

		return messagesWithCache;
	}

	private selectCacheBreakpoints(messages: AnthropicMessage[], maxCount: number): Set<number> {
		if (maxCount <= 0) {
			return new Set();
		}

		const eligible = messages
			.map((msg, index) => ({ msg, index }))
			.filter(({ msg }) => Array.isArray(msg.content) && this.findCacheableBlockIndex(msg.content) !== -1);
		const lastEligible = eligible[eligible.length - 1]?.index;
		const selected: number[] = [];
		const selectedSet = new Set<number>();

		const add = (index: number | undefined) => {
			if (index === undefined || selectedSet.has(index) || selected.length >= maxCount) {
				return;
			}
			selected.push(index);
			selectedSet.add(index);
		};

		// Copilot usually sends reusable workspace/file context near the front.
		const contextIndex =
			eligible.find(({ msg, index }) => index !== lastEligible && msg.role === "user")?.index ??
			eligible.find(({ index }) => index !== lastEligible)?.index;
		add(contextIndex);

		const reservedForLast = lastEligible !== undefined && !selectedSet.has(lastEligible) ? 1 : 0;
		const longContextCandidates = eligible
			.filter(({ index }) => index !== contextIndex && index !== lastEligible)
			.map(({ msg, index }) => ({ index, textLength: this.getMessageTextLength(msg) }))
			.filter(({ textLength }) => textLength > 1024)
			.sort((a, b) => b.index - a.index);

		for (const candidate of longContextCandidates) {
			if (selected.length >= maxCount - reservedForLast) {
				break;
			}
			add(candidate.index);
		}

		// Always cache the final eligible message so the next turn can reuse the full prefix.
		add(lastEligible);

		return selectedSet;
	}

	private findCacheableBlockIndex(content: string | AnthropicContentBlock[]): number {
		if (!Array.isArray(content)) {
			return -1;
		}
		for (let i = content.length - 1; i >= 0; i--) {
			const block = content[i];
			if (block.type === "text" || block.type === "image") {
				return i;
			}
		}
		return -1;
	}

	private getMessageTextLength(message: AnthropicMessage): number {
		if (typeof message.content === "string") {
			return message.content.length;
		}
		return message.content
			.filter((block) => block.type === "text")
			.reduce((sum, block) => sum + ("text" in block ? block.text.length : 0), 0);
	}

	/**
	 * Anthropic requires every assistant tool_use to be followed immediately by
	 * a user message containing the matching tool_result. VS Code histories can
	 * contain interrupted or pruned tool calls, so remove unmatched tool blocks
	 * before sending the conversation upstream.
	 */
	private sanitizeToolUsePairs(messages: AnthropicMessage[]): AnthropicMessage[] {
		const sanitized: AnthropicMessage[] = [];

		for (let i = 0; i < messages.length; i++) {
			const current = messages[i];
			const currentBlocks = Array.isArray(current.content) ? current.content : undefined;

			if (current.role === "assistant" && currentBlocks) {
				const toolUseIds = currentBlocks
					.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
					.map((block) => block.id);

				if (toolUseIds.length > 0) {
					const next = messages[i + 1];
					const nextBlocks = next && next.role === "user" && Array.isArray(next.content) ? next.content : [];
					const resultIds = new Set(
						nextBlocks
							.filter((block): block is AnthropicToolResultBlock => block.type === "tool_result")
							.map((block) => block.tool_use_id)
					);
					const matchedToolUseIds = new Set(toolUseIds.filter((id) => resultIds.has(id)));
					const filteredBlocks = currentBlocks.filter(
						(block) => block.type !== "tool_use" || matchedToolUseIds.has(block.id)
					);

					if (filteredBlocks.length > 0) {
						sanitized.push({ ...current, content: filteredBlocks });
					}
					continue;
				}
			}

			if (current.role === "user" && currentBlocks) {
				const previous = sanitized[sanitized.length - 1];
				const previousBlocks = previous && previous.role === "assistant" && Array.isArray(previous.content)
					? previous.content
					: [];
				const previousToolUseIds = new Set(
					previousBlocks
						.filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
						.map((block) => block.id)
				);
				const filteredBlocks = currentBlocks.filter(
					(block) => block.type !== "tool_result" || previousToolUseIds.has(block.tool_use_id)
				);

				if (filteredBlocks.length > 0) {
					sanitized.push({ ...current, content: filteredBlocks });
				}
				continue;
			}

			sanitized.push(current);
		}

		return sanitized;
	}

	prepareRequestBody(
		rb: any,
		um: ZenMuxModelInfo | undefined,
		options: ProvideLanguageModelChatResponseOptions
	): any {
		const arb = rb as AnthropicRequestBody;
		// Set max_tokens (required for Anthropic)
		// if (um?.max_tokens !== undefined) {
		// 	arb.max_tokens = um.max_tokens;
		// }

		// Add system content with prompt-cache breakpoint.
		if (this._systemContent) {
			arb.system = [
				{
					type: "text",
					text: this._systemContent,
					cache_control: { type: "ephemeral" },
				},
			];
		}

		// Add temperature
		// const oTemperature = options.modelOptions?.temperature ?? 0;
		// const temperature = um?.temperature ?? oTemperature;
		// arb.temperature = temperature;
		// if (um && um.temperature === null) {
		// 	delete arb.temperature;
		// }

		// // Add top_p if configured
		// if (um?.top_p !== undefined && um.top_p !== null) {
		// 	arb.top_p = um.top_p;
		// }

		// // Add top_k if configured
		// if (um?.top_k !== undefined) {
		// 	arb.top_k = um.top_k;
		// }

		// Add tools configuration
		const toolConfig = convertToolsToOpenAIWithSupport(options, um);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Anthropic format
			arb.tools = toolConfig.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));
		}

		// Add tool_choice
		if (toolConfig.tool_choice) {
			if (toolConfig.tool_choice === "auto") {
				arb.tool_choice = { type: "auto" };
			} else if (typeof toolConfig.tool_choice === "object" && toolConfig.tool_choice.type === "function") {
				arb.tool_choice = { type: "tool", name: toolConfig.tool_choice.function.name };
			}
		}

		// Reasoning depth selected by the user. Prefer passing the effort through
		// untouched via output_config (ZenMux gateway semantics, matching the official
		// custom-endpoint request shape); only fall back to a client-computed
		// thinking budget when the gateway declares the raw Anthropic `thinking`
		// parameter instead. Anthropic does not support forced tool calling while
		// thinking is enabled, so skip it in that case.
		const reasoningEffort = getConfiguredReasoningEffort(options);
		if (
			reasoningEffort &&
			modelSupportsReasoning(um) &&
			arb.tool_choice?.type !== "tool"
		) {
			if (supportsParameter(um?.supported_parameters, "output_config")) {
				arb.output_config = { effort: reasoningEffort };
			} else if (supportsParameter(um?.supported_parameters, "thinking")) {
				const maxTokens = arb.max_tokens ?? 4096;
				arb.thinking = {
					type: "enabled",
					budget_tokens: computeThinkingBudget(reasoningEffort, maxTokens),
				};
			}
		}

		// Process extra configuration parameters
		// if (um?.extra && typeof um.extra === "object") {
		// 	// Add all extra parameters directly to the request body
		// 	for (const [key, value] of Object.entries(um.extra)) {
		// 		if (value !== undefined) {
		// 			(arb as unknown as Record<string, unknown>)[key] = value;
		// 		}
		// 	}
		// }

		return arb;
	}

	/**
	 * Process Anthropic streaming response (SSE format).
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
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						continue;
					}

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);
						// console.debug("[ZenMux Model Provider] data:", JSON.stringify(chunk));

						await this.processAnthropicChunk(chunk, progress);
					} catch (e) {
						console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
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
	 * Process a single Anthropic streaming chunk.
	 * @param chunk Parsed Anthropic stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processAnthropicChunk(
		chunk: AnthropicStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		// Handle ping events (ignore)
		if (chunk.type === "ping") {
			return;
		}

		// Handle error events
		if (chunk.type === "error") {
			const errorType = chunk.error?.type || "unknown_error";
			const errorMessage = chunk.error?.message || "Anthropic API streaming error";
			console.error(`[Anthropic Provider] Streaming error: ${errorType} - ${errorMessage}`);
			// We could throw here, but for now just log and continue
			return;
		}

		if (chunk.type === "message_start" && chunk.message) {
			// Extract message metadata (id, model, etc.)
			// Could store for later use, but not required for basic streaming
			return;
		}

		if (chunk.type === "message_delta" && chunk.delta) {
			// Extract stop_reason and usage information
			// We're not processing usage per user request, but could log if needed
			return;
		}

		if (chunk.type === "content_block_start" && chunk.content_block) {
			// Start of a content block
			if (chunk.content_block.type === "thinking") {
				// Start thinking block
				if (chunk.content_block.thinking) {
					this.bufferThinkingContent(chunk.content_block.thinking, progress);
				}
			} else if (chunk.content_block.type === "tool_use") {
				// Start tool call block
				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}
				const idx = (chunk.index as number) ?? 0;
				this._toolCallBuffers.set(idx, {
					id: chunk.content_block.id,
					name: chunk.content_block.name,
					args: "",
				});
			} else if (chunk.content_block.type === "text") {
				// Text block start - nothing special to do
				// The text content will come via content_block_delta events
			}
		} else if (chunk.type === "content_block_delta" && chunk.delta) {
			if (chunk.delta.type === "text_delta" && chunk.delta.text) {
				// Emit text content
				progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
				this._hasEmittedAssistantText = true;
			} else if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
				// Buffer thinking content
				this.bufferThinkingContent(chunk.delta.thinking, progress);
			} else if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
				// Handle tool call argument streaming
				// Find the latest tool call buffer and append partial JSON
				const idx = (chunk.index as number) ?? 0;
				const buf = this._toolCallBuffers.get(idx);
				if (buf) {
					buf.args += chunk.delta.partial_json;
					this._toolCallBuffers.set(idx, buf);
					// Try to emit if we have valid JSON
					await this.tryEmitBufferedToolCall(idx, progress);
				}
			} else if (chunk.delta.type === "signature_delta" && chunk.delta.signature) {
				const thinkingId = this._currentThinkingId;
				if (thinkingId) {
					progress.report(new vscode.LanguageModelThinkingPart("", thinkingId, { signature: chunk.delta.signature }));
				}
			}
		} else if (chunk.type === "content_block_stop" || chunk.type === "message_stop") {
			// End of message - ensure thinking is ended and flush all tool calls
			await this.flushToolCallBuffers(progress, false);
			this.reportEndThinking(progress);
		}
	}
}
