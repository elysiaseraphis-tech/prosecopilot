/**
 * Copilot Manager IPC Client
 * ==========================
 *
 * Standalone TypeScript library for consuming Copilot Manager IPC from another
 * RisuAI plugin. Drop this file into your plugin source tree.
 *
 * Requirements:
 *   - RisuAI Plugin API v3.0 (plugin channel support)
 *   - Your plugin: //@allowed-ipc copilot-manager
 *   - Copilot Manager: add your plugin name to its //@allowed-ipc
 *   - Enable "IPC" in Copilot Manager settings
 *
 * Quick start:
 *
 * ```ts
 * import { CopilotManagerClient, toTextStream } from "./copilot-manager-client";
 *
 * const client = new CopilotManagerClient();
 *
 * // Simple chat
 * const { content } = await client.chat({
 *     model_id: "gpt-4.1",
 *     messages: [{ role: "user", content: "hi" }],
 * });
 *
 * // Streaming
 * const { stream, meta } = client.chatStream({
 *     model_id: "claude-sonnet-4.7",
 *     messages: [{ role: "user", content: "count to 5" }],
 * });
 * for await (const text of toTextStream(stream)) {
 *     process.stdout.write(text); // or append to DOM
 * }
 *
 * // Tool chain (multi-turn)
 * const chainId = client.generateChainId();
 * const first = await client.chat({
 *     model_id: "gpt-4.1",
 *     chain_id: chainId,
 *     tools: [{ name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } }],
 *     messages: [{ role: "user", content: "search for cats" }],
 * });
 * if (first.toolCalls?.length) {
 *     const toolResults = first.toolCalls.map(call => ({
 *         role: "tool" as const,
 *         tool_call_id: call.id,
 *         content: JSON.stringify({ results: ["cat1", "cat2"] }),
 *     }));
 *     const final = await client.chat({
 *         model_id: "gpt-4.1",
 *         chain_id: chainId,
 *         tools: [{ name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } }],
 *         messages: [
 *             { role: "user", content: "search for cats" },
 *             { role: "assistant", content: first.content, tool_calls: first.toolCalls },
 *             ...toolResults,
 *         ],
 *     });
 *     console.log(final.content);
 * }
 *
 * // OpenAI-compatible
 * const completion = await client.openaiCompletion({
 *     model: "gpt-4.1",
 *     messages: [{ role: "user", content: "hi" }],
 * });
 *
 * // RisuAI Provider bridge
 * import { createCopilotProvider } from "./copilot-manager-client";
 * const provider = createCopilotProvider(client, "gpt-4.1");
 * ```
 *
 * @module copilot-manager-client
 */

// ============================================================================
// RisuAI API types (minimal surface used by this library)
// ============================================================================

export type RisuChannelListener = (message: unknown, meta: { sender: string; channel: string }) => void;

export interface RisuPluginChannelApi {
    addPluginChannelListener?: (channel: string, handler: RisuChannelListener) => void;
    postPluginChannelMessage?: (targetPlugin: string, channel: string, message: unknown) => void;
}

export interface RisuChatMessage {
    role: "system" | "user" | "assistant" | "function" | "char";
    content: string;
    name?: string;
    multimodals?: Array<{
        type: "image" | "video" | "audio";
        base64: string;
        height?: number;
        width?: number;
    }>;
}

export interface RisuProviderArguments {
    prompt_chat: RisuChatMessage[];
    temperature?: number;
    top_p?: number;
    top_k?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;
}

export interface RisuProviderResponse {
    success: boolean;
    content: string | ReadableStream<string>;
}

export type RisuProviderFunction = (
    args: RisuProviderArguments,
    abortSignal?: AbortSignal,
) => Promise<RisuProviderResponse>;

// ============================================================================
// IPC protocol types
// ============================================================================

export type IpcOp = "status" | "listModels" | "chat" | "cancel";

export type IpcResponseType = "status" | "models" | "accepted" | "chunk" | "done" | "error";

export type IpcErrorCode =
    | "IPC_DISABLED"
    | "NOT_CONFIGURED"
    | "BUSY"
    | "UNKNOWN_MODEL"
    | "INVALID_KEY"
    | "INVALID_REQUEST"
    | "DUPLICATE_ID"
    | "UNKNOWN_REQUEST"
    | "API_ERROR"
    | "CANCELLED"
    | "INTERNAL";

export interface IpcRequestEnvelope {
    id: string;
    op: IpcOp;
    payload?: unknown;
}

export interface IpcResponseEnvelope {
    id: string;
    type: IpcResponseType;
    data: unknown;
}

export interface QuotaInfo {
    limit: number;
    used: number;
}

export interface KeyInfo {
    index: number;
    alias: string;
    quota: QuotaInfo;
}

export interface StatusData {
    configured: boolean;
    activeIndex: number;
    keys: KeyInfo[];
}

export interface ListModelsData {
    modelIds: string[];
}

export type TypedChunkPhase = "thinking" | "text" | "raw";

export interface TypedChunk {
    phase: TypedChunkPhase;
    text: string;
}

export interface TokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
}

export interface ToolCall {
    id: string;
    name: string;
    /** Opaque model output. Usually JSON but can be malformed — preserve as-is. */
    arguments: string;
}

export interface ToolDefinition {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
}

export type IpcMessageRole = "system" | "user" | "assistant" | "function" | "char" | "tool";

export interface IpcChatMessage {
    role: IpcMessageRole;
    content?: string;
    name?: string;
    function_call?: unknown;
    multimodals?: RisuChatMessage["multimodals"];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    is_error?: boolean;
    /** Opaque provider contexts from a previous response. Advanced use only. */
    provider_contexts?: unknown[];
}

export interface AcceptedData {
    streaming: boolean;
    realtimeChunks: boolean;
    raw: boolean;
    turn: "user" | "agent";
    toolCount: number;
}

export interface ChatDoneData {
    success: true;
    content: string;
    thinking?: string;
    usage?: TokenUsage;
    durationMs?: number;
    stopReason?: string;
    toolCalls?: ToolCall[];
    /** Opaque context for tool chain continuity. Managed automatically via chain_id. */
    providerContext?: unknown;
}

export interface ChatPayload {
    model_id: string;
    messages: IpcChatMessage[];
    tools?: ToolDefinition[];
    turn?: "auto" | "user" | "agent";
    chain_id?: string;

    temperature?: number;
    top_p?: number;
    top_k?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;

    effort?: "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    thinking_budget?: number;
    omit_thinking?: boolean;
    use_instructions?: boolean;
    detailed_summary?: boolean;
    verbosity?: "low" | "medium" | "high";

    format?: "auto" | "anthropic" | "responses" | "openai";
    streaming?: boolean;
    realtime_chunks?: boolean;
    raw?: boolean;
    key_index?: number;
}

// ============================================================================
// Errors
// ============================================================================

export class CopilotManagerError extends Error {
    public readonly code: IpcErrorCode;

    constructor(code: IpcErrorCode, message: string) {
        super(`[${code}] ${message}`);
        this.name = "CopilotManagerError";
        this.code = code;
    }
}

export class CopilotManagerTimeoutError extends Error {
    public readonly op: IpcOp;
    public readonly timeoutMs: number;

    constructor(op: IpcOp, timeoutMs: number) {
        super(`Copilot Manager IPC '${op}' timed out after ${timeoutMs}ms`);
        this.name = "CopilotManagerTimeoutError";
        this.op = op;
        this.timeoutMs = timeoutMs;
    }
}

// ============================================================================
// Client
// ============================================================================

export interface CopilotManagerClientOptions {
    /** Target plugin name. Default: `"copilot-manager"`. */
    targetPlugin?: string;
    /** Default timeout in ms. Default: 60_000. */
    defaultTimeoutMs?: number;
    /** Channel API provider. Default: `globalThis.risuAPI`. */
    api?: RisuPluginChannelApi;
}

export interface CallOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface ChatStream {
    stream: ReadableStream<TypedChunk>;
    accepted: Promise<AcceptedData>;
    meta: Promise<ChatStreamMeta>;
    cancel: () => void;
}

export interface ChatStreamMeta {
    usage?: TokenUsage;
    durationMs?: number;
    stopReason?: string;
    toolCalls?: ToolCall[];
    providerContext?: unknown;
    /** Present only when transport couldn't deliver realtime chunks. */
    collectedContent?: string;
    collectedThinking?: string;
}

type ResponseHandler = (msg: IpcResponseEnvelope) => void;

const REQUEST_CHANNEL = "copilot-manager/request";
const RESPONSE_CHANNEL = "copilot-manager/response";

/**
 * Main entry point. Construct once and reuse across requests.
 *
 * Registers a single channel listener; concurrent calls are multiplexed by id.
 */
export class CopilotManagerClient {
    private readonly targetPlugin: string;
    private readonly defaultTimeoutMs: number;
    private readonly api: RisuPluginChannelApi;
    private readonly pending = new Map<string, ResponseHandler>();
    private idCounter = 0;

    constructor(options: CopilotManagerClientOptions = {}) {
        this.targetPlugin = options.targetPlugin ?? "copilot-manager";
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
        this.api = options.api ?? (globalThis as unknown as { risuAPI?: RisuPluginChannelApi }).risuAPI ?? {};

        if (
            typeof this.api.addPluginChannelListener !== "function" ||
            typeof this.api.postPluginChannelMessage !== "function"
        ) {
            throw new Error(
                "RisuAI plugin channel API unavailable. Requires v3.0 with " +
                    "//@allowed-ipc declared on both your plugin and copilot-manager.",
            );
        }

        this.api.addPluginChannelListener(RESPONSE_CHANNEL, (raw) => {
            const msg = this.validateEnvelope(raw);
            if (!msg) return;
            const handler = this.pending.get(msg.id);
            if (handler) handler(msg);
        });
    }

    /** Generate a unique chain_id for tool call sequences. */
    generateChainId(): string {
        return `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /** Query configuration state and per-key quota. */
    async status(options: CallOptions = {}): Promise<StatusData> {
        return this.callSingle<StatusData>("status", undefined, options, ["status"]);
    }

    /** List visible (not hidden) cached model IDs. */
    async listModels(options: CallOptions = {}): Promise<ListModelsData> {
        return this.callSingle<ListModelsData>("listModels", undefined, options, ["models"]);
    }

    /** Non-streaming chat. Use `chatStream()` for realtime delivery. */
    async chat(payload: ChatPayload, options: CallOptions = {}): Promise<ChatDoneData> {
        const finalPayload: ChatPayload = { ...payload, streaming: false, realtime_chunks: false };
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

        return new Promise<ChatDoneData>((resolve, reject) => {
            const id = this.nextId();
            const finalize = this.createFinalizer(id, options.signal, timeoutMs, "chat", reject, true);

            this.pending.set(id, (msg) => {
                if (msg.type === "accepted") return;
                if (msg.type === "error") {
                    finalize.settle();
                    const e = msg.data as { code: IpcErrorCode; message: string };
                    reject(new CopilotManagerError(e.code, e.message));
                    return;
                }
                if (msg.type === "done") {
                    finalize.settle();
                    resolve(msg.data as ChatDoneData);
                    return;
                }
            });

            finalize.arm();
            this.send(id, "chat", finalPayload);
        });
    }

    /**
     * Streaming chat. If the transport cannot deliver realtime chunks,
     * a single synthetic chunk is emitted before the stream closes.
     */
    chatStream(payload: ChatPayload, options: CallOptions = {}): ChatStream {
        const finalPayload: ChatPayload = { ...payload, streaming: true, realtime_chunks: true };
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

        const id = this.nextId();

        let acceptedResolve!: (v: AcceptedData) => void;
        let acceptedReject!: (e: Error) => void;
        const acceptedPromise = new Promise<AcceptedData>((res, rej) => {
            acceptedResolve = res;
            acceptedReject = rej;
        });

        let metaResolve!: (v: ChatStreamMeta) => void;
        let metaReject!: (e: Error) => void;
        const metaPromise = new Promise<ChatStreamMeta>((res, rej) => {
            metaResolve = res;
            metaReject = rej;
        });

        let settled = false;
        let acceptedReceived = false;
        let gotChunk = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            settled = true;
            this.pending.delete(id);
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        };

        const fail = (e: Error) => {
            if (!acceptedReceived) acceptedReject(e);
            metaReject(e);
        };

        const onAbort = () => {
            if (settled) return;
            cleanup();
            this.sendCancel(id);
            fail(new DOMException("Aborted", "AbortError"));
        };

        const stream = new ReadableStream<TypedChunk>({
            start: (controller) => {
                this.pending.set(id, (msg) => {
                    if (settled) return;

                    if (msg.type === "accepted") {
                        acceptedReceived = true;
                        acceptedResolve(msg.data as AcceptedData);
                        return;
                    }

                    if (msg.type === "chunk") {
                        gotChunk = true;
                        controller.enqueue(msg.data as TypedChunk);
                        return;
                    }

                    if (msg.type === "error") {
                        cleanup();
                        const err = msg.data as { code: IpcErrorCode; message: string };
                        const e = new CopilotManagerError(err.code, err.message);
                        controller.error(e);
                        fail(e);
                        return;
                    }

                    if (msg.type === "done") {
                        cleanup();
                        const data = msg.data as ChatDoneData;
                        const meta: ChatStreamMeta = {
                            usage: data.usage,
                            durationMs: data.durationMs,
                            stopReason: data.stopReason,
                            toolCalls: data.toolCalls,
                            providerContext: data.providerContext,
                        };

                        if (!gotChunk) {
                            if (data.thinking) {
                                controller.enqueue({ phase: "thinking", text: data.thinking });
                            }
                            if (data.content) {
                                controller.enqueue({ phase: "text", text: data.content });
                            }
                            meta.collectedContent = data.content;
                            if (data.thinking) meta.collectedThinking = data.thinking;
                        }

                        controller.close();
                        metaResolve(meta);
                    }
                });

                if (options.signal?.aborted) {
                    onAbort();
                    return;
                }
                options.signal?.addEventListener("abort", onAbort);

                timer = setTimeout(() => {
                    if (settled) return;
                    cleanup();
                    this.sendCancel(id);
                    const e = new CopilotManagerTimeoutError("chat", timeoutMs);
                    controller.error(e);
                    fail(e);
                }, timeoutMs);

                this.send(id, "chat", finalPayload);
            },
            cancel: (reason) => {
                if (settled) return;
                cleanup();
                this.sendCancel(id);
                const e = reason instanceof Error ? reason : new DOMException("Cancelled", "AbortError");
                fail(e);
            },
        });

        return {
            stream,
            accepted: acceptedPromise,
            meta: metaPromise,
            cancel: onAbort,
        };
    }

    /** Cancel an in-flight chat by its request id. Fire-and-forget. */
    cancel(targetId: string): void {
        this.sendCancel(targetId);
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    private nextId(): string {
        this.idCounter = (this.idCounter + 1) >>> 0;
        const rand = Math.random().toString(36).slice(2, 8);
        return `cm-${Date.now().toString(36)}-${this.idCounter.toString(36)}-${rand}`;
    }

    private send(id: string, op: IpcOp, payload?: unknown): void {
        this.api.postPluginChannelMessage!(this.targetPlugin, REQUEST_CHANNEL, { id, op, payload });
    }

    private sendCancel(targetId: string): void {
        try {
            this.send(this.nextId(), "cancel", { target_id: targetId });
        } catch {
            /* host teardown */
        }
    }

    private validateEnvelope(raw: unknown): IpcResponseEnvelope | null {
        if (!raw || typeof raw !== "object") return null;
        const v = raw as Record<string, unknown>;
        if (typeof v.id !== "string" || typeof v.type !== "string") return null;
        return { id: v.id, type: v.type as IpcResponseType, data: v.data };
    }

    private callSingle<T>(
        op: IpcOp,
        payload: unknown,
        opts: CallOptions,
        acceptedTypes: IpcResponseType[],
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

        return new Promise<T>((resolve, reject) => {
            const id = this.nextId();
            const finalize = this.createFinalizer(id, opts.signal, timeoutMs, op, reject, false);

            this.pending.set(id, (msg) => {
                if (msg.type === "error") {
                    finalize.settle();
                    const e = msg.data as { code: IpcErrorCode; message: string };
                    reject(new CopilotManagerError(e.code, e.message));
                    return;
                }
                if (acceptedTypes.includes(msg.type)) {
                    finalize.settle();
                    resolve(msg.data as T);
                }
            });

            finalize.arm();
            this.send(id, op, payload);
        });
    }

    private createFinalizer(
        id: string,
        signal: AbortSignal | undefined,
        timeoutMs: number,
        op: IpcOp,
        reject: (e: Error) => void,
        cancelOnAbort: boolean,
    ) {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const settle = () => {
            if (settled) return;
            settled = true;
            this.pending.delete(id);
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
            if (settled) return;
            settle();
            if (cancelOnAbort) this.sendCancel(id);
            reject(new DOMException("Aborted", "AbortError"));
        };

        const arm = () => {
            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener("abort", onAbort);

            timer = setTimeout(() => {
                if (settled) return;
                settle();
                if (cancelOnAbort) this.sendCancel(id);
                reject(new CopilotManagerTimeoutError(op, timeoutMs));
            }, timeoutMs);
        };

        return { settle, arm };
    }

    // ------------------------------------------------------------------------
    // OpenAI-compatible helpers
    // ------------------------------------------------------------------------

    /**
     * OpenAI Chat Completions compatible single-response call.
     * Tool-enabled calls require `copilot_manager.chain_id`.
     */
    async openaiCompletion(
        body: OpenAIChatCompletionRequest,
        options: CallOptions = {},
    ): Promise<OpenAIChatCompletion> {
        if (body.stream) {
            throw new Error("openaiCompletion: use openaiCompletionStream for stream=true");
        }
        const payload = translateOpenAIRequestToChat(body);
        const done = await this.chat(payload, options);
        return buildOpenAICompletion(body.model, done);
    }

    /**
     * OpenAI Chat Completions streaming. Returns an AsyncGenerator of
     * `chat.completion.chunk` objects matching OpenAI's SSE schema.
     */
    async *openaiCompletionStream(
        body: OpenAIChatCompletionRequest,
        options: CallOptions = {},
    ): AsyncGenerator<OpenAIChatCompletionChunk, void, void> {
        const payload = translateOpenAIRequestToChat(body);
        const chat = this.chatStream(payload, options);

        const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const created = Math.floor(Date.now() / 1000);
        let first = true;

        try {
            const reader = chat.stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value.phase !== "text") continue;

                    yield {
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model: body.model,
                        choices: [
                            {
                                index: 0,
                                delta: first ? { role: "assistant", content: value.text } : { content: value.text },
                                finish_reason: null,
                            },
                        ],
                    };
                    first = false;
                }
            } finally {
                reader.releaseLock();
            }

            const meta = await chat.meta;
            if (meta.toolCalls?.length) {
                yield {
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: body.model,
                    choices: [
                        {
                            index: 0,
                            delta: first
                                ? { role: "assistant", tool_calls: toOpenAIToolCalls(meta.toolCalls) }
                                : { tool_calls: toOpenAIToolCalls(meta.toolCalls) },
                            finish_reason: null,
                        },
                    ],
                };
                first = false;
            }

            yield {
                id,
                object: "chat.completion.chunk",
                created,
                model: body.model,
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: normalizeOpenAIFinishReason(meta.stopReason, meta.toolCalls),
                    },
                ],
            };
        } finally {
            chat.cancel();
        }
    }
}

// ============================================================================
// Stream helpers
// ============================================================================

/** Filter a typed-chunk stream to plain text only (drops thinking/raw). */
export function toTextStream(source: ReadableStream<TypedChunk>): ReadableStream<string> {
    const reader = source.getReader();
    return new ReadableStream<string>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                if (value.phase === "text") controller.enqueue(value.text);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/**
 * Convert typed-chunk stream to a string stream with thinking markers,
 * matching the format RisuAI provider functions expect.
 */
export function toProviderStream(
    source: ReadableStream<TypedChunk>,
    options: { showThinking?: boolean } = {},
): ReadableStream<string> {
    const showThinking = options.showThinking ?? true;
    const reader = source.getReader();
    let thinkingOpen = false;

    return new ReadableStream<string>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    if (showThinking && thinkingOpen) controller.enqueue("\n</Thoughts>\n\n");
                    controller.close();
                    return;
                }

                if (value.phase === "thinking") {
                    if (!showThinking) return;
                    if (!thinkingOpen) {
                        thinkingOpen = true;
                        controller.enqueue("<Thoughts>\n\n");
                    }
                    controller.enqueue(value.text);
                    return;
                }

                if (value.phase === "text") {
                    if (showThinking && thinkingOpen) {
                        controller.enqueue("\n</Thoughts>\n\n");
                        thinkingOpen = false;
                    }
                    controller.enqueue(value.text);
                    return;
                }

                // phase === "raw"
                controller.enqueue(value.text);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

// ============================================================================
// Provider adapter
// ============================================================================

export interface CreateProviderOptions {
    /** Enable streaming. Default: true. */
    streaming?: boolean;
    /** Include thinking markers. Default: true. */
    showThinking?: boolean;
    /** Static overrides for every request. */
    defaults?: Partial<Omit<ChatPayload, "model_id" | "messages">>;
    /** Per-request timeout override. */
    timeoutMs?: number;
}

/**
 * Bridge a Copilot Manager model to a RisuAI ProviderFunction.
 *
 * ```ts
 * const provider = createCopilotProvider(client, "gpt-4.1", {
 *     defaults: { effort: "medium" },
 * });
 * ```
 */
export function createCopilotProvider(
    client: CopilotManagerClient,
    modelId: string,
    options: CreateProviderOptions = {},
): RisuProviderFunction {
    const useStreaming = options.streaming ?? true;
    const showThinking = options.showThinking ?? true;
    const defaults = options.defaults ?? {};
    const timeoutMs = options.timeoutMs;

    return async (args, signal) => {
        const payload: ChatPayload = {
            ...defaults,
            model_id: modelId,
            messages: args.prompt_chat.map((message) => ({ ...message })),
            temperature: args.temperature ?? defaults.temperature,
            top_p: args.top_p ?? defaults.top_p,
            top_k: args.top_k ?? defaults.top_k,
            frequency_penalty: args.frequency_penalty ?? defaults.frequency_penalty,
            presence_penalty: args.presence_penalty ?? defaults.presence_penalty,
            max_tokens: args.max_tokens ?? defaults.max_tokens,
        };

        const callOpts: CallOptions = { signal, timeoutMs };

        try {
            if (!useStreaming) {
                const done = await client.chat(payload, callOpts);
                return { success: true, content: renderStringContent(done, showThinking) };
            }

            const chat = client.chatStream(payload, callOpts);
            const content = toProviderStream(chat.stream, { showThinking });
            return { success: true, content };
        } catch (error) {
            const message =
                error instanceof CopilotManagerError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : String(error);
            return { success: false, content: `[copilot-manager] ${message}` };
        }
    };
}

function renderStringContent(done: ChatDoneData, showThinking: boolean): string {
    if (showThinking && done.thinking) {
        return `<Thoughts>\n\n${done.thinking}\n</Thoughts>\n\n${done.content}`;
    }
    return done.content;
}

// ============================================================================
// OpenAI-compatible types & translators
// ============================================================================

export interface OpenAIChatCompletionRequest {
    model: string;
    messages: OpenAICompletionMessage[];
    tools?: OpenAIToolDefinition[];
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    stream?: boolean;
    reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    /** Pass-through to Copilot Manager chat payload. Tool calls require chain_id here. */
    copilot_manager?: Partial<Omit<ChatPayload, "model_id" | "messages">>;
}

export interface OpenAICompletionMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | OpenAICompletionContentPart[] | null;
    name?: string;
    tool_calls?: OpenAIChatToolCall[];
    tool_call_id?: string;
}

export type OpenAICompletionContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export interface OpenAIChatToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface OpenAIToolDefinition {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface OpenAIChatCompletion {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: { role: "assistant"; content: string; tool_calls?: OpenAIChatToolCall[] };
        finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export interface OpenAIChatCompletionChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: { role?: "assistant"; content?: string; tool_calls?: OpenAIChatToolCall[] };
        finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
    }>;
}

function translateOpenAIRequestToChat(body: OpenAIChatCompletionRequest): ChatPayload {
    const messages: IpcChatMessage[] = body.messages.map((m) => {
        const { text, multimodals } = flattenOpenAIContent(m.content);
        const base: IpcChatMessage = { role: normalizeOpenAIRole(m.role) };
        if (text || m.content !== null) base.content = text;
        if (m.name) base.name = m.name;
        if (multimodals.length > 0) base.multimodals = multimodals;
        if (m.role === "tool" && m.tool_call_id) base.tool_call_id = m.tool_call_id;
        if (m.tool_calls?.length) {
            base.tool_calls = m.tool_calls.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
            }));
        }
        return base;
    });

    const payload: ChatPayload = {
        ...body.copilot_manager,
        model_id: body.model,
        messages,
    };
    const convertedTools = toToolDefinitions(body.tools);
    if (convertedTools.length > 0 && !payload.tools?.length) payload.tools = convertedTools;

    if (body.temperature != null) payload.temperature = body.temperature;
    if (body.top_p != null) payload.top_p = body.top_p;
    if (body.frequency_penalty != null) payload.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty != null) payload.presence_penalty = body.presence_penalty;

    const maxTokens = body.max_completion_tokens ?? body.max_tokens;
    if (maxTokens != null) payload.max_tokens = maxTokens;

    if (body.reasoning_effort != null) payload.effort = body.reasoning_effort;
    if (
        (payload.tools?.length || payload.turn === "agent" || payload.messages.at(-1)?.role === "tool") &&
        !payload.chain_id
    ) {
        throw new Error("Copilot Manager IPC tool calls require copilot_manager.chain_id");
    }

    return payload;
}

function normalizeOpenAIRole(role: OpenAICompletionMessage["role"]): IpcChatMessage["role"] {
    return role;
}

function flattenOpenAIContent(content: string | OpenAICompletionContentPart[] | null | undefined): {
    text: string;
    multimodals: NonNullable<RisuChatMessage["multimodals"]>;
} {
    if (content == null) return { text: "", multimodals: [] };
    if (typeof content === "string") return { text: content, multimodals: [] };

    const texts: string[] = [];
    const multimodals: NonNullable<RisuChatMessage["multimodals"]> = [];
    for (const part of content) {
        if (part.type === "text") {
            texts.push(part.text);
            continue;
        }
        if (part.type === "image_url") {
            const url = part.image_url.url;
            if (!url.startsWith("data:")) {
                throw new TypeError(
                    "Copilot Manager IPC requires data URLs for images " +
                        "(e.g. 'data:image/png;base64,...'). Remote URLs are not supported.",
                );
            }
            multimodals.push({ type: "image", base64: url });
            continue;
        }
    }
    return { text: texts.join("\n"), multimodals };
}

function buildOpenAICompletion(model: string, done: ChatDoneData): OpenAIChatCompletion {
    const usage = done.usage;
    const hasUsage =
        usage != null && (usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null);

    return {
        id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: done.content,
                    tool_calls: done.toolCalls?.length ? toOpenAIToolCalls(done.toolCalls) : undefined,
                },
                finish_reason: normalizeOpenAIFinishReason(done.stopReason, done.toolCalls),
            },
        ],
        usage: hasUsage
            ? {
                  prompt_tokens: usage!.inputTokens ?? 0,
                  completion_tokens: usage!.outputTokens ?? 0,
                  total_tokens: usage!.totalTokens ?? (usage!.inputTokens ?? 0) + (usage!.outputTokens ?? 0),
              }
            : undefined,
    };
}

function toToolDefinitions(tools: OpenAIToolDefinition[] | undefined): ToolDefinition[] {
    return (
        tools?.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
            strict: tool.function.strict,
        })) ?? []
    );
}

function toOpenAIToolCalls(toolCalls: ToolCall[]): OpenAIChatToolCall[] {
    return toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
            name: call.name,
            arguments: call.arguments,
        },
    }));
}

function normalizeOpenAIFinishReason(
    stopReason: string | undefined,
    toolCalls: ToolCall[] | undefined,
): "stop" | "length" | "content_filter" | "tool_calls" | null {
    if (toolCalls?.length) return "tool_calls";
    if (stopReason === "length" || stopReason === "max_tokens") return "length";
    if (stopReason === "content_filter") return "content_filter";
    return "stop";
}
