import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 180_000;

export class CodexAppServerError extends Error {
  constructor(code, message, { cause = undefined, details = undefined } = {}) {
    super(message, { cause });
    this.name = "CodexAppServerError";
    this.code = code;
    this.details = details;
  }
}

function textInput(message) {
  return [{ type: "text", text: String(message) }];
}

function jsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function keyForTurn(threadId, turnId) {
  return `${threadId}:${turnId}`;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class CodexAppServerClient {
  constructor({
    root,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    serviceName = "oz-brunch-chat",
    spawnProcess = spawn,
    logger = () => {},
    clientInfo = { name: "oz-brunch-chat", title: "OZ Brunch Chat", version: "0.1.0" }
  } = {}) {
    if (typeof root !== "string" || !root) throw new CodexAppServerError("invalid_client", "App Server root is required.");
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.serviceName = serviceName;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.clientInfo = clientInfo;
    this.child = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.turns = new Map();
    this.completedTurns = new Map();
    this.earlyNotifications = new Map();
    this.started = false;
    this.stopping = false;
    this.stderrBytes = 0;
  }

  async start() {
    if (this.started && this.child && !this.stopping) return;
    this.child = this.spawnProcess("codex", ["--search", "app-server", "--stdio"], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.stopping = false;
    this.buffer = "";
    this.child.stdout.on("data", (chunk) => this.#read(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.byteLength;
    });
    this.child.on("error", (error) => this.#processFailed(new CodexAppServerError("process_error", errorMessage(error), { cause: error })));
    this.child.on("close", (code, signal) => {
      this.started = false;
      if (!this.stopping) this.#processFailed(new CodexAppServerError("process_closed", `App Server exited (code ${code ?? "null"}, signal ${signal ?? "none"}).`));
    });
    try {
      await this.#request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true }
      });
      this.#notify("initialized", {});
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    this.started = false;
    this.#processFailed(new CodexAppServerError("client_stopped", "App Server client stopped."));
    const child = this.child;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } else child.kill("SIGTERM");
    await closePromise;
  }

  async startExecutionThread({
    model = "gpt-5.6-luna",
    cwd = this.root,
    approvalPolicy = "never",
    sandbox = "read-only",
    ephemeral = true,
    serviceName = this.serviceName
  } = {}) {
    await this.start();
    const result = await this.#request("thread/start", {
      cwd,
      model,
      approvalPolicy,
      sandbox,
      ephemeral,
      serviceName
    });
    if (!result?.thread?.id) throw new CodexAppServerError("invalid_thread", "App Server did not return a thread id.", { details: result });
    return result;
  }

  async startTurn({
    threadId,
    prompt,
    outputSchema,
    model = "gpt-5.6-luna",
    reasoningEffort = "medium",
    sandboxPolicy = { type: "readOnly", networkAccess: true },
    cwd = undefined,
    signal = undefined,
    onEvent = undefined
  } = {}) {
    if (!threadId || typeof prompt !== "string" || !prompt) throw new CodexAppServerError("invalid_turn", "threadId and prompt are required.");
    const result = await this.#request("turn/start", {
      threadId,
      input: textInput(prompt),
      outputSchema,
      model,
      effort: reasoningEffort,
      sandboxPolicy,
      ...(cwd ? { cwd } : {})
    });
    const turnId = result?.turn?.id;
    if (!turnId) throw new CodexAppServerError("invalid_turn", "App Server did not return a turn id.", { details: result });
    const context = this.#createTurnContext(threadId, turnId, onEvent);
    const execution = {
      threadId,
      turnId,
      turn: result.turn,
      started: context.started.promise,
      completion: context.completion.promise,
      steer: (message) => this.steerTurn({ threadId, turnId, message }),
      interrupt: () => this.interruptTurn({ threadId, turnId }),
      wait: ({ timeoutMs = this.timeoutMs, waitSignal = signal } = {}) => this.waitForTurn({ threadId, turnId, timeoutMs, signal: waitSignal })
    };
    this.#consumeEarlyNotifications(context);
    return execution;
  }

  async steerTurn({ threadId, turnId, message } = {}) {
    if (!threadId || !turnId || typeof message !== "string" || !message.trim()) throw new CodexAppServerError("invalid_steer", "threadId, turnId, and a non-empty message are required.");
    return this.#request("turn/steer", { threadId, expectedTurnId: turnId, input: textInput(message) });
  }

  async interruptTurn({ threadId, turnId } = {}) {
    if (!threadId || !turnId) throw new CodexAppServerError("invalid_interrupt", "threadId and turnId are required.");
    return this.#request("turn/interrupt", { threadId, turnId });
  }

  async cleanupThread({ threadId, ephemeral = true } = {}) {
    if (!threadId || !this.child || this.stopping) return null;
    try {
      return await this.#request(ephemeral ? "thread/unsubscribe" : "thread/delete", { threadId });
    } catch (error) {
      this.logger({ type: "app_server_thread_cleanup_failed", threadId, errorCode: error?.code ?? "cleanup_failed", errorMessage: errorMessage(error) });
      return null;
    }
  }

  async waitForTurn({ threadId, turnId, timeoutMs = this.timeoutMs, signal } = {}) {
    const key = keyForTurn(threadId, turnId);
    const context = this.turns.get(key) ?? this.completedTurns.get(key);
    if (!context) throw new CodexAppServerError("turn_not_found", "The App Server turn is no longer active.");
    if (signal?.aborted) throw new CodexAppServerError("cancelled", "App Server turn was cancelled.");
    let timer;
    let abort;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CodexAppServerError("timeout", "App Server turn timed out.")), timeoutMs);
    });
    const cancellation = signal
      ? new Promise((_, reject) => {
        abort = () => reject(new CodexAppServerError("cancelled", "App Server turn was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
      })
      : new Promise(() => {});
    try {
      return await Promise.race([context.completion.promise, timeout, cancellation]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      if (context.completed) this.completedTurns.delete(key);
    }
  }

  #request(method, params) {
    if (!this.child || this.stopping) return Promise.reject(new CodexAppServerError("client_unavailable", "App Server client is not running."));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new CodexAppServerError("rpc_timeout", `${method} timed out.`));
      }, this.timeoutMs);
      this.pendingRequests.set(id, { method, timer, resolve, reject });
      try {
        jsonLine(this.child.stdin, { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new CodexAppServerError("write_failed", errorMessage(error), { cause: error }));
      }
    });
  }

  #notify(method, params) {
    if (!this.child || this.stopping) throw new CodexAppServerError("client_unavailable", "App Server client is not running.");
    jsonLine(this.child.stdin, { jsonrpc: "2.0", method, params });
  }

  #read(chunk) {
    this.buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#processFailed(new CodexAppServerError("malformed_json", "App Server emitted malformed JSON-RPC output.", { cause: error }));
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(message, "id") && (message.result !== undefined || message.error !== undefined)) {
        const request = this.pendingRequests.get(message.id);
        if (!request) continue;
        this.pendingRequests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new CodexAppServerError("rpc_error", `App Server ${request.method} failed: ${message.error.message ?? "unknown JSON-RPC error"}`, { details: message.error }));
        else request.resolve(message.result);
        continue;
      }
      if (message.method) this.#dispatchNotification(message);
    }
  }

  #dispatchNotification(notification) {
    const params = notification.params ?? {};
    const threadId = params.threadId;
    const turnId = params.turnId ?? params.turn?.id;
    if (!threadId || !turnId) {
      return;
    }
    const key = keyForTurn(threadId, turnId);
    const context = this.turns.get(key);
    if (!context) {
      const early = this.earlyNotifications.get(key) ?? [];
      early.push(notification);
      this.earlyNotifications.set(key, early.slice(-100));
      return;
    }
    this.#applyNotification(context, notification);
  }

  #createTurnContext(threadId, turnId, onEvent) {
    const context = {
      threadId,
      turnId,
      started: createDeferred(),
      completion: createDeferred(),
      deltas: new Map(),
      tokenUsage: null,
      completed: false,
      onEvent
    };
    this.turns.set(keyForTurn(threadId, turnId), context);
    return context;
  }

  #consumeEarlyNotifications(context) {
    const key = keyForTurn(context.threadId, context.turnId);
    const early = this.earlyNotifications.get(key) ?? [];
    this.earlyNotifications.delete(key);
    early.forEach((notification) => this.#applyNotification(context, notification));
  }

  #applyNotification(context, notification) {
    const params = notification.params ?? {};
    context.onEvent?.(notification);
    if (notification.method === "turn/started") {
      context.started.resolve(params.turn);
      return;
    }
    if (notification.method === "item/agentMessage/delta" && typeof params.delta === "string" && params.itemId) {
      context.deltas.set(params.itemId, `${context.deltas.get(params.itemId) ?? ""}${params.delta}`);
      return;
    }
    if (notification.method === "item/completed" && params.item?.type === "agentMessage" && params.item.id) {
      if (typeof params.item.text === "string") context.deltas.set(params.item.id, params.item.text);
      return;
    }
    if (notification.method === "thread/tokenUsage/updated" && params.tokenUsage && typeof params.tokenUsage === "object") {
      context.tokenUsage = params.tokenUsage;
      return;
    }
    if (notification.method === "turn/completed") {
      context.completed = true;
      this.turns.delete(keyForTurn(context.threadId, context.turnId));
      this.completedTurns.set(keyForTurn(context.threadId, context.turnId), context);
      context.completion.resolve({
        ...params.turn,
        raw: [...context.deltas.values()].join(""),
        ...(context.tokenUsage ? { tokenUsage: context.tokenUsage } : {})
      });
      this.logger({ type: "app_server_turn_completed", threadId: context.threadId, turnId: context.turnId, status: params.turn?.status });
    }
  }

  #processFailed(error) {
    for (const request of this.pendingRequests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pendingRequests.clear();
    for (const context of this.turns.values()) {
      context.started.reject(error);
      context.completion.reject(error);
    }
    this.turns.clear();
  }
}
