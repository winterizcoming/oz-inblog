import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../lib/codex-app-server-client.mjs";
import { AppServerTransport } from "../lib/oz-brunch-app-server-transport.mjs";

class FakeAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 43210;
    this.exitCode = null;
    this.signalCode = null;
    this.threadCount = 0;
    this.turnCount = 0;
    this.turns = new Map();
    this.steers = [];
    this.interrupts = [];
    this.deletedThreads = [];
    this.unsubscribedThreads = [];
    this.suppressResponses = false;
    this.experimentalApi = false;
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) this.#handle(JSON.parse(line));
    });
  }

  #send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #handle(request) {
    if (this.suppressResponses) return;
    if (request.method === "initialize") {
      this.experimentalApi = request.params.capabilities?.experimentalApi === true;
      this.#send({ jsonrpc: "2.0", id: request.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
      return;
    }
    if (request.method === "thread/start") {
      this.threadCount += 1;
      const threadId = `thread-${this.threadCount}`;
      this.#send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: threadId, ephemeral: request.params.ephemeral === true } } });
      this.#send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId } } });
      return;
    }
    if (request.method === "turn/start") {
      this.turnCount += 1;
      const turnId = `turn-${this.turnCount}`;
      this.turns.set(request.params.threadId, turnId);
      this.#send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
      queueMicrotask(() => this.#send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: request.params.threadId, turn: { id: turnId, status: "inProgress" } } }));
      return;
    }
    if (request.method === "turn/steer") {
      this.steers.push(request.params);
      this.#send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: request.params.expectedTurnId, status: "inProgress" } } });
      this.#complete(request.params.threadId, request.params.expectedTurnId, "{\"markdown\":\"steered\",\"choices\":[]}");
      return;
    }
    if (request.method === "turn/interrupt") {
      this.interrupts.push(request.params);
      this.#send({ jsonrpc: "2.0", id: request.id, result: {} });
      this.#complete(request.params.threadId, request.params.turnId, "", "interrupted");
      return;
    }
    if (request.method === "thread/delete") {
      if (!this.experimentalApi) {
        this.#send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "experimental API not enabled" } });
        return;
      }
      this.deletedThreads.push(request.params.threadId);
      this.#send({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (request.method === "thread/unsubscribe") {
      this.unsubscribedThreads.push(request.params.threadId);
      this.#send({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    this.#send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }

  #complete(threadId, turnId, text, status = "completed") {
    const itemId = `${turnId}-message`;
    if (text) {
      this.#send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text } });
      this.#send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text } } });
    }
    this.#send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status, error: null } } });
  }

  kill(signal = "SIGTERM") {
    this.signalCode = signal;
    this.exitCode = null;
    this.emit("close", null, signal);
  }
}

test("App Server client performs handshake, routes request ids, and preserves same turn steering", async () => {
  const process = new FakeAppServerProcess();
  const client = new CodexAppServerClient({ root: "/workspace", spawnProcess: () => process, timeoutMs: 5000 });
  const thread = await client.startExecutionThread({ model: "gpt-5.6-luna" });
  const execution = await client.startTurn({ threadId: thread.thread.id, prompt: "first", outputSchema: { type: "object" } });
  await execution.started;
  const steer = await execution.steer("change direction");
  const completed = await execution.wait();
  assert.equal(steer.turn.id, execution.turnId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.raw, '{"markdown":"steered","choices":[]}');
  assert.equal(process.steers.length, 1);
  assert.equal(process.steers[0].expectedTurnId, execution.turnId);
  await client.stop();
});

test("App Server client interrupts an active turn without fabricating an assistant response", async () => {
  const process = new FakeAppServerProcess();
  const client = new CodexAppServerClient({ root: "/workspace", spawnProcess: () => process, timeoutMs: 5000 });
  const thread = await client.startExecutionThread();
  const execution = await client.startTurn({ threadId: thread.thread.id, prompt: "long", outputSchema: { type: "object" } });
  await execution.started;
  await execution.interrupt();
  const completed = await execution.wait();
  assert.equal(completed.status, "interrupted");
  assert.equal(completed.raw, "");
  assert.equal(process.interrupts[0].turnId, execution.turnId);
  await client.stop();
});

test("App Server client rejects malformed JSON and crashes pending requests", async () => {
  const process = new FakeAppServerProcess();
  const client = new CodexAppServerClient({ root: "/workspace", spawnProcess: () => process, timeoutMs: 5000 });
  await client.start();
  process.suppressResponses = true;
  const pending = client.startExecutionThread();
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write("not-json\n");
  await assert.rejects(() => pending, (error) => error.code === "malformed_json");
  await client.stop();
});

test("App Server client unsubscribes ephemeral execution threads during cleanup", async () => {
  // Given
  const process = new FakeAppServerProcess();
  const client = new CodexAppServerClient({ root: "/workspace", spawnProcess: () => process, timeoutMs: 5000 });
  const thread = await client.startExecutionThread({ ephemeral: true });

  // When
  await client.cleanupThread({ threadId: thread.thread.id, ephemeral: true });

  // Then
  assert.deepEqual(process.deletedThreads, []);
  assert.deepEqual(process.unsubscribedThreads, [thread.thread.id]);
  await client.stop();
});

test("App Server client deletes persisted execution threads during cleanup", async () => {
  // Given
  const process = new FakeAppServerProcess();
  const client = new CodexAppServerClient({ root: "/workspace", spawnProcess: () => process, timeoutMs: 5000 });
  const thread = await client.startExecutionThread({ ephemeral: false });

  // When
  await client.cleanupThread({ threadId: thread.thread.id, ephemeral: false });

  // Then
  assert.deepEqual(process.deletedThreads, [thread.thread.id]);
  assert.deepEqual(process.unsubscribedThreads, []);
  await client.stop();
});

test("App Server transport uses a deletable execution thread by default", async () => {
  // Given
  let startedEphemeral;
  let cleanedEphemeral;
  const client = {
    async startExecutionThread(options) {
      startedEphemeral = options.ephemeral;
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return {
        threadId: "thread-1",
        turnId: "turn-1",
        started: Promise.resolve(),
        async wait() { return { status: "completed", raw: '{"markdown":"ok","choices":[]}' }; },
        async steer() {},
        async interrupt() {}
      };
    },
    async cleanupThread(options) { cleanedEphemeral = options.ephemeral; }
  };
  const transport = new AppServerTransport({ client, root: "/workspace" });

  // When
  const result = await transport.executeTurn({ prompt: "test", model: "gpt-5.6-luna", reasoningEffort: "medium" });

  // Then
  assert.equal(result.code, 0);
  assert.equal(startedEphemeral, false);
  assert.equal(cleanedEphemeral, false);
});

test("App Server transport pipeline reuses one ephemeral thread and cleans it once", async () => {
  // Given
  const startedThreads = [];
  const startedTurns = [];
  const cleanedThreads = [];
  let turnCount = 0;
  const client = {
    async startExecutionThread(options) {
      startedThreads.push(options);
      return { thread: { id: "pipeline-thread" } };
    },
    async startTurn(options) {
      turnCount += 1;
      const turnId = `pipeline-turn-${turnCount}`;
      startedTurns.push({ ...options, turnId });
      return {
        threadId: options.threadId,
        turnId,
        started: Promise.resolve(),
        async wait() { return { status: "completed", raw: JSON.stringify({ markdown: `stage-${turnCount}`, choices: [] }) }; },
        async steer() {},
        async interrupt() {}
      };
    },
    async cleanupThread(options) { cleanedThreads.push(options); }
  };
  const transport = new AppServerTransport({ client, root: "/workspace" });

  // When
  const pipeline = await transport.beginPipeline({ model: "gpt-5.6-sol" });
  const first = await pipeline.executeTurn({ prompt: "first", outputSchema: { type: "object" }, model: "gpt-5.6-sol", reasoningEffort: "high" });
  const second = await pipeline.executeTurn({ prompt: "second", outputSchema: { type: "array" }, model: "gpt-5.6-sol", reasoningEffort: "high" });
  await pipeline.close();
  await pipeline.close();

  // Then
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(startedThreads.length, 1);
  assert.equal(startedThreads[0].ephemeral, true);
  assert.deepEqual(startedTurns.map(({ threadId }) => threadId), ["pipeline-thread", "pipeline-thread"]);
  assert.deepEqual(startedTurns.map(({ outputSchema }) => outputSchema.type), ["object", "array"]);
  assert.deepEqual(cleanedThreads, [{ threadId: "pipeline-thread", ephemeral: true }]);
});

test("App Server transport does not share a pipeline context across user turns", async () => {
  const startedThreads = [];
  const cleanedThreads = [];
  const client = {
    async startExecutionThread(options) {
      const threadId = `turn-thread-${startedThreads.length + 1}`;
      startedThreads.push({ ...options, threadId });
      return { thread: { id: threadId } };
    },
    async cleanupThread(options) { cleanedThreads.push(options); }
  };
  const transport = new AppServerTransport({ client, root: "/workspace" });

  const first = await transport.beginPipeline({ model: "gpt-5.6-sol" });
  const second = await transport.beginPipeline({ model: "gpt-5.6-sol" });
  await first.close();
  await second.close();

  assert.notEqual(first.threadId, second.threadId);
  assert.deepEqual(startedThreads.map(({ ephemeral }) => ephemeral), [true, true]);
  assert.deepEqual(cleanedThreads.map(({ threadId }) => threadId), [first.threadId, second.threadId]);
});
