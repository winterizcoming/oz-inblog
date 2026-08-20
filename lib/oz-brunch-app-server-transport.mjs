import { extractLastJsonObject } from "../scripts/codex-provider-common.mjs";
import { removeAppServerNullableFields } from "./oz-brunch-transport-normalizer.mjs";

function normalizeTransportRaw(raw) {
  const text = String(raw ?? "").trim();
  try {
    return JSON.stringify(removeAppServerNullableFields(JSON.parse(text)));
  } catch {
    const candidate = extractLastJsonObject(text);
    if (candidate === text) return text;
    try {
      return JSON.stringify(removeAppServerNullableFields(JSON.parse(candidate)));
    } catch {
      return candidate;
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const PUBLIC_EVENT_METHODS = new Set([
  "turn/started",
  "turn/completed",
  "turn/failed",
  "webSearch/started",
  "webSearch/completed",
  "thread/tokenUsage/updated",
  "item/completed"
]);

function publicEvent(notification) {
  const item = notification?.params?.item;
  if (notification?.method === "webSearch/started" || notification?.method === "webSearch/completed") {
    const params = notification?.params ?? {};
    const query = typeof params.query === "string" && params.query.trim()
      ? params.query
      : typeof params.searchQuery === "string" && params.searchQuery.trim()
        ? params.searchQuery
        : null;
    return {
      type: "app_server_search_event",
      method: notification.method,
      query,
      action: params.action && typeof params.action === "object" ? params.action : null,
      resultCount: Number.isInteger(params.resultCount) ? params.resultCount : "unknown",
      openedUrls: Array.isArray(params.openedUrls) ? params.openedUrls.filter((url) => typeof url === "string") : "unknown"
    };
  }
  if ((notification?.method === "item/started" || notification?.method === "item/completed") && item?.type === "webSearch") {
    return {
      type: "app_server_search_event",
      method: notification.method,
      itemId: typeof item.id === "string" ? item.id : undefined,
      query: typeof item.query === "string" && item.query.trim() ? item.query : null,
      action: item.action && typeof item.action === "object" ? item.action : null,
      resultCount: Number.isInteger(item.resultCount) ? item.resultCount : "unknown",
      openedUrls: Array.isArray(item.openedUrls) ? item.openedUrls.filter((url) => typeof url === "string") : "unknown"
    };
  }
  if (notification?.method === "thread/tokenUsage/updated") {
    const tokenUsage = notification?.params?.tokenUsage;
    return {
      type: "app_server_token_usage",
      method: notification.method,
      tokenUsage: tokenUsage && typeof tokenUsage === "object" ? tokenUsage : null
    };
  }
  if (!PUBLIC_EVENT_METHODS.has(notification?.method)) return null;
  const params = notification?.params ?? {};
  const turn = params.turn ?? {};
  if (notification.method === "item/completed" && params.item?.type !== "agentMessage") return null;
  return {
    type: "app_server_event",
    method: notification?.method ?? "unknown",
    threadId: typeof params.threadId === "string" ? params.threadId : undefined,
    turnId: typeof params.turnId === "string" ? params.turnId : typeof turn.id === "string" ? turn.id : undefined,
    status: typeof turn.status === "string" ? turn.status : undefined
  };
}

export class AppServerTransport {
  constructor({ client, outputSchema, root, timeoutMs = 180_000, interruptGraceMs = 5_000, logger = () => {} } = {}) {
    if (!client) throw new Error("AppServerTransport requires a CodexAppServerClient.");
    this.client = client;
    this.outputSchema = outputSchema;
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.interruptGraceMs = interruptGraceMs;
    this.logger = logger;
    this.supportsPipeline = true;
    this.supportsPipelineContext = true;
  }

  async executeTurn({
    prompt,
    model,
    reasoningEffort,
    outputSchema = this.outputSchema,
    sandboxPolicy = { type: "readOnly", networkAccess: true },
    ephemeral = false,
    signal,
    timeoutMs = this.timeoutMs,
    onEvent,
    onGeneration,
    onGenerationFinished
  } = {}) {
    const startedAt = Date.now();
    let thread;
    try {
      thread = await this.client.startExecutionThread({ model, cwd: this.root, ephemeral });
      return await this.#executeTurnOnThread({
        threadId: thread.thread.id,
        prompt,
        outputSchema,
        model,
        reasoningEffort,
        sandboxPolicy,
        signal,
        timeoutMs,
        onEvent,
        onGeneration,
        onGenerationFinished
      });
    } catch (error) {
      const code = error?.code === "timeout" ? 124 : error?.code === "cancelled" ? 130 : 1;
      return { code, timedOut: code === 124, cancelled: code === 130, durationMs: Date.now() - startedAt, model, reasoningEffort, stderr: errorMessage(error) };
    } finally {
      if (thread?.thread?.id) await this.client.cleanupThread({ threadId: thread.thread.id, ephemeral });
    }
  }

  async beginPipeline({ model, cwd = this.root, ephemeral = true } = {}) {
    const thread = await this.client.startExecutionThread({ model, cwd, ephemeral });
    const threadId = thread.thread.id;
    let closed = false;
    return {
      threadId,
      executeTurn: (options = {}) => this.#executeTurnOnThread({ ...options, threadId }),
      close: async () => {
        if (closed) return;
        closed = true;
        await this.client.cleanupThread({ threadId, ephemeral });
      }
    };
  }

  async #executeTurnOnThread({
    threadId,
    prompt,
    model,
    reasoningEffort,
    outputSchema = this.outputSchema,
    sandboxPolicy = { type: "readOnly", networkAccess: true },
    signal,
    timeoutMs = this.timeoutMs,
    onEvent,
    onGeneration,
    onGenerationFinished
  } = {}) {
    const startedAt = Date.now();
    let execution;
    let generation;
    let interruptRequested = false;
    let abortHandler;
    try {
      if (signal?.aborted) return { code: 130, cancelled: true, durationMs: 0, model, reasoningEffort };
      execution = await this.client.startTurn({
        threadId,
        prompt,
        outputSchema,
        model,
        reasoningEffort,
        sandboxPolicy,
        signal,
        onEvent: (notification) => {
          const event = publicEvent(notification);
          if (event) onEvent?.(event);
        }
      });
      generation = {
        threadId: execution.threadId,
        turnId: execution.turnId,
        model,
        reasoningEffort,
        startedAt,
        steer: (message) => execution.steer(message),
        interrupt: () => {
          interruptRequested = true;
          return execution.interrupt();
        }
      };
      await execution.started;
      onGeneration?.(generation);
      abortHandler = () => {
        interruptRequested = true;
        execution.interrupt().catch((error) => this.logger({ type: "app_server_interrupt_failed", errorCode: error?.code ?? "interrupt_failed" }));
      };
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
      const completed = await execution.wait({ timeoutMs });
      const durationMs = Date.now() - startedAt;
      if (completed.status === "interrupted" || interruptRequested) {
        return { code: 130, cancelled: true, durationMs, model, reasoningEffort, generation };
      }
      if (completed.status !== "completed") {
        return { code: 1, durationMs, model, reasoningEffort, generation, stderr: completed.error ? errorMessage(completed.error) : "" };
      }
      return { code: 0, raw: normalizeTransportRaw(completed.raw), durationMs, model, reasoningEffort, generation, ...(completed.tokenUsage ? { tokenUsage: completed.tokenUsage } : {}) };
    } catch (error) {
      const code = error?.code === "timeout" ? 124 : error?.code === "cancelled" ? 130 : 1;
      if ((code === 124 || code === 130) && execution && !interruptRequested) {
        interruptRequested = true;
        try { await execution.interrupt(); } catch (interruptError) { this.logger({ type: "app_server_interrupt_failed", errorCode: interruptError?.code ?? "interrupt_failed" }); }
        try {
          await execution.wait({ timeoutMs: this.interruptGraceMs, waitSignal: null });
        } catch (interruptWaitError) {
          this.logger({ type: "app_server_interrupt_wait_expired", errorCode: interruptWaitError?.code ?? "interrupt_wait_failed" });
        }
      }
      return { code, timedOut: code === 124, cancelled: code === 130, durationMs: Date.now() - startedAt, model, reasoningEffort, generation, stderr: errorMessage(error) };
    } finally {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      if (generation) onGenerationFinished?.(generation);
    }
  }
}
