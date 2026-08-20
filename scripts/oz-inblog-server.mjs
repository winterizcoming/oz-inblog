import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CodexAppServerClient } from "../lib/codex-app-server-client.mjs";
import { AppServerTransport } from "../lib/oz-brunch-app-server-transport.mjs";
import { evaluateBrunchWritingReadiness, validateReadinessInput } from "../lib/oz-brunch-readiness-runner.mjs";
import { getBrunchModelCapabilities, resolveBrunchModelPreset } from "../lib/oz-brunch-models.mjs";
import {
  BrunchSkillError,
  buildAppServerOutputSchema,
  createFileSessionStore,
  hashBrunchMarkdown,
  patchBrunchChatPreview,
  runBrunchSkillTurn,
  safeSessionId,
  validateTurnInput,
  withBrunchSessionLock
} from "../lib/oz-inblog-runner.mjs";
import { isDebugTraceEnabled } from "../lib/oz-brunch-debug-trace.mjs";
import { CURATED_DISCOVERY_RUNTIME_PROFILE } from "../lib/oz-brunch-runtime-profile.mjs";
import { restoreSessionV3Version, sessionV3Metadata, sessionV3VersionSummaries } from "../lib/oz-brunch-session-v3.mjs";
import { listAvailableWritingSkills } from "../lib/oz-writing-skill-registry.mjs";
import { refineBrunchWritingPreview, validateWritingRefineInput } from "../lib/oz-writing-skill-runner.mjs";
import { createSecureDataDirectories, resolveOzDataPaths } from "../lib/oz-inblog-data.mjs";
import { loadReleaseManifest, releaseMetadata } from "../lib/oz-inblog-release.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
});

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": CONTENT_TYPES[".json"], "cache-control": "no-store" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath);
  response.writeHead(200, { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(filePath).pipe(response);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new BrunchSkillError("body_too_large", "Request body is too large.", { status: 413, retryable: false }));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new BrunchSkillError("invalid_json", "Request body must be valid JSON.", { status: 400, retryable: false })); }
    });
    request.on("error", reject);
  });
}

function publicError(error, fallbackCode = "request_failed") {
  if (error instanceof BrunchSkillError || error?.name === "WritingSkillError") {
    return { status: error.status ?? 500, payload: { ok: false, code: error.code, message: error.message, retryable: error.retryable ?? false, ...(error.fieldErrors ? { field_errors: error.fieldErrors } : {}) } };
  }
  return { status: 500, payload: { ok: false, code: fallbackCode, message: "The request could not be completed.", retryable: true } };
}

function messageMetadata(record) {
  if (record?.sessionVersion !== 3 || !Array.isArray(record.turns) || !Array.isArray(record.branches)) return {};
  const branch = record.branches.find((entry) => entry.branchId === record.activeBranchId);
  if (!branch) return {};
  const turns = new Map(record.turns.map((turn) => [turn.turnId, turn]));
  const metadata = {};
  let messageIndex = 0;
  for (const turnId of branch.turnIds ?? []) {
    const turn = turns.get(turnId);
    messageIndex += turn?.userInputs?.length ?? 0;
    const versionId = branch.versionSelections?.[turnId] ?? turn?.activeVersionId;
    const version = turn?.assistantVersions?.find((entry) => entry.versionId === versionId);
    if (!version) continue;
    metadata[String(messageIndex)] = {
      turnId,
      versionId,
      branchId: branch.branchId,
      versionSummaries: sessionV3VersionSummaries(record, { turnId }),
      ...(version.writingReadiness ? { readiness: version.writingReadiness } : {})
    };
    messageIndex += 1;
  }
  return metadata;
}

function sessionSummary(entry) {
  const messages = entry.record?.messages ?? [];
  const preview = [...messages].reverse().find((message) => message?.content?.writing_preview)?.content?.writing_preview;
  const firstUser = messages.find((message) => message?.role === "user")?.content;
  const phase = entry.record?.editorial_state?.phase ?? "topic_discovery";
  return {
    workflow_session_id: entry.sessionId,
    workflow_kind: "brunch_chat",
    schema_version: String(entry.record?.sessionVersion ?? 3),
    runtime_version: "v1.0a",
    created_at: null,
    updated_at: entry.updatedAt ?? null,
    source: "brunch_chat",
    title: String(preview?.title || firstUser || "새 브런치 대화").slice(0, 120),
    target_track: "brunch",
    current_step: phase,
    last_step: phase,
    status: "active",
    event_count: messages.length,
    recoverable: true,
    read_only: false,
    test_like: false,
    warnings: [],
    writing_preview: Boolean(preview),
    message_count: messages.length
  };
}

async function defaultCodexStatus() {
  try {
    const [{ stdout: doctor }, { stdout: login }] = await Promise.all([
      execFileAsync("codex", ["doctor", "--json"], { timeout: 20_000 }),
      execFileAsync("codex", ["login", "status"], { timeout: 20_000 })
    ]);
    return { ready: /logged in/i.test(login), doctor: JSON.parse(doctor) };
  } catch (error) {
    return { ready: false, code: error?.code ?? "codex_unavailable" };
  }
}

function logEvent(event) {
  const safe = Object.fromEntries(Object.entries(event ?? {}).filter(([key]) => !["message", "prompt", "response", "markdown", "content"].includes(key)));
  process.stderr.write(`[oz-inblog] ${JSON.stringify(safe)}\n`);
}

export function createOzInblogServer({ root = DEFAULT_ROOT, env = process.env, codexStatus = defaultCodexStatus, runner = runBrunchSkillTurn } = {}) {
  const manifest = loadReleaseManifest(root);
  const dataPaths = createSecureDataDirectories(resolveOzDataPaths({ env }));
  if (env.OZ_BRUNCH_DEBUG_TRACE === "1" && !env.OZ_BRUNCH_DEBUG_DIR) process.env.OZ_BRUNCH_DEBUG_DIR = dataPaths.debug;
  const sessionStore = createFileSessionStore({ root, directory: dataPaths.sessions });
  const client = new CodexAppServerClient({ root, serviceName: "oz-inblog", logger: logEvent });
  const transport = new AppServerTransport({ client, outputSchema: buildAppServerOutputSchema(), root, logger: logEvent });
  const generations = new Map();
  // The release uses the existing v0-3 UI unchanged. The public server only
  // changes the backend surface; it does not introduce a replacement screen.
  const uiDirectory = path.join(root, "ui", "v0-3");

  async function startGeneration(input) {
    if (Object.hasOwn(input, "runtimeProfile")) throw new BrunchSkillError("runtime_profile_not_configurable", "The public runtime profile is fixed to v1.0a.", { status: 422, retryable: false });
    const request = validateTurnInput(input);
    const preset = resolveBrunchModelPreset(input.modelPreset);
    if (!preset) throw new BrunchSkillError("invalid_request", "The selected model is not available.", { status: 422, retryable: false });
    const generationId = typeof input.generationId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input.generationId) ? input.generationId : crypto.randomUUID();
    if (generations.has(generationId)) throw new BrunchSkillError("generation_locked", "This generation is already running.", { status: 409, retryable: true });
    const controller = new AbortController();
    const record = { generationId, sessionId: request.sessionId, status: "running", activity: "request_received", startedAt: Date.now(), controller, steering: [] };
    generations.set(generationId, record);
    void runner({
      sessionId: request.sessionId,
      message: request.message,
      interaction: input.interaction ?? null,
      sessionStore,
      executionTransport: transport,
      signal: controller.signal,
      model: preset.model,
      reasoningEffort: preset.reasoningEffort,
      modelPreset: preset.preset,
      runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
      defaultRuntimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
      extraUserMessages: record.steering,
      onProgress(progress) { Object.assign(record, { activity: progress.activity, operation: progress.operation, stage: progress.stage, editorialPhase: progress.editorialPhase }); },
      onGeneration(generation) { record.generation = generation; },
      onLog: logEvent
    }).then((result) => {
      Object.assign(record, { status: "completed", activity: "finishing_response", response: result.response, metadata: result.metadata, completedAt: Date.now() });
    }).catch((error) => {
      const failure = publicError(error, "brunch_chat_failed");
      Object.assign(record, { status: controller.signal.aborted ? "interrupted" : "failed", error: failure.payload, completedAt: Date.now() });
    });
    return record;
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/healthz") { sendJson(response, 200, { ok: true, version: manifest.displayVersion }); return; }
      if (url.pathname === "/readyz") {
        const codex = await codexStatus();
        sendJson(response, codex.ready ? 200 : 503, { ready: codex.ready === true, dataDirectory: dataPaths.root, skillReady: fs.existsSync(path.join(root, "skills", "oz-brunch-editorial-chat", "SKILL.md")), codexReady: codex.ready === true });
        return;
      }
      if (url.pathname === "/api/meta") { sendJson(response, 200, releaseMetadata(manifest)); return; }
      if (url.pathname === "/api/oz-brunch-chat/capabilities" && request.method === "GET") { sendJson(response, 200, { ...getBrunchModelCapabilities(), debugTraceEnabled: isDebugTraceEnabled(env), runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE }); return; }
      if (url.pathname === "/api/oz-brunch-chat/sessions" && request.method === "GET") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
        const sessions = (await sessionStore.list({ limit })).filter((entry) => entry.record?.messages?.length).map(sessionSummary);
        sendJson(response, 200, { sessions, next_cursor: null, limit });
        return;
      }
      const sessionMatch = url.pathname.match(/^\/api\/oz-brunch-chat\/sessions\/([^/]+)$/u);
      if (sessionMatch && request.method === "GET") {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const record = await sessionStore.read(sessionId);
        if (!record.messages?.length) { sendJson(response, 404, { error: "Brunch chat session not found" }); return; }
        sendJson(response, 200, { sessionId, messages: record.messages, messageMeta: messageMetadata(record), modelPreset: record.defaultModelPreset, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, editorialPhase: record.editorial_state?.phase, storageVersion: 3 });
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/generations" && request.method === "POST") {
        const record = await startGeneration(await readJsonBody(request));
        sendJson(response, 202, { generationId: record.generationId, status: record.status, activity: record.activity });
        return;
      }
      const generationMatch = url.pathname.match(/^\/api\/oz-brunch-chat\/generations\/([^/]+)$/u);
      if (generationMatch && request.method === "GET") {
        const record = generations.get(decodeURIComponent(generationMatch[1]));
        if (!record || record.sessionId !== url.searchParams.get("sessionId")) { sendJson(response, 404, { ok: false, code: "generation_not_found", message: "Generation not found.", retryable: true }); return; }
        sendJson(response, 200, { generationId: record.generationId, status: record.status, activity: record.activity, operation: record.operation, stage: record.stage, editorialPhase: record.editorialPhase, elapsedMs: Date.now() - record.startedAt, ...(record.response ? { response: record.response, metadata: record.metadata } : {}), ...(record.error ? { error: record.error } : {}) });
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/abort" && request.method === "POST") {
        const input = await readJsonBody(request);
        const record = generations.get(input.generationId);
        if (!record || record.sessionId !== input.sessionId) throw new BrunchSkillError("generation_not_found", "Generation not found.", { status: 404, retryable: true });
        record.controller.abort();
        await record.generation?.interrupt?.();
        record.status = "interrupting";
        sendJson(response, 200, { ok: true, generationId: input.generationId, status: record.status });
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/steer" && request.method === "POST") {
        const input = await readJsonBody(request);
        const record = generations.get(input.generationId);
        if (!record || record.sessionId !== input.sessionId || record.status !== "running") throw new BrunchSkillError("generation_not_found", "Generation not found.", { status: 404, retryable: true });
        const message = String(input.message ?? "").trim();
        if (!message) throw new BrunchSkillError("invalid_request", "A steer message is required.", { status: 422, retryable: false });
        record.steering.push(message);
        await record.generation?.steer?.(message);
        sendJson(response, 200, { ok: true, generationId: input.generationId, status: record.status });
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/preview" && request.method === "PATCH") {
        const input = await readJsonBody(request);
        sendJson(response, 200, await patchBrunchChatPreview({ ...input, sessionStore }));
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/preview/skills" && request.method === "GET") { sendJson(response, 200, { skills: listAvailableWritingSkills().map(({ id, label }) => ({ id, label })) }); return; }
      if (url.pathname === "/api/oz-brunch-chat/preview/refine" && request.method === "POST") {
        const input = validateWritingRefineInput(await readJsonBody(request));
        const preset = resolveBrunchModelPreset(input.modelPreset);
        if (!preset) throw new BrunchSkillError("invalid_request", "The selected model is not available.", { status: 422, retryable: false });
        sendJson(response, 200, await refineBrunchWritingPreview({ root, ...input, sessionStore, executionTransport: transport, model: preset.model, reasoningEffort: preset.reasoningEffort, modelPreset: preset.preset, onLog: logEvent }));
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/preview/readiness" && request.method === "POST") {
        const input = validateReadinessInput(await readJsonBody(request));
        sendJson(response, 200, await evaluateBrunchWritingReadiness({ root, ...input, sessionStore, executionTransport: transport, onLog: logEvent }));
        return;
      }
      if (url.pathname === "/api/oz-brunch-chat/restore-version" && request.method === "POST") {
        const input = await readJsonBody(request);
        const result = await withBrunchSessionLock({ sessionStore, sessionId: input.sessionId, operation: async () => {
          const current = await sessionStore.read(input.sessionId);
          const next = restoreSessionV3Version({ ...current, sessionId: current.sessionId ?? input.sessionId }, input);
          await sessionStore.write(input.sessionId, next.messages, sessionV3Metadata(next));
          const turn = next.turns.find((entry) => entry.turnId === input.turnId);
          const version = turn?.assistantVersions.find((entry) => entry.versionId === input.versionId);
          return { branchId: next.activeBranchId, turnId: input.turnId, versionId: input.versionId, response: version?.content, messages: next.messages, messageMeta: messageMetadata(next), editorialPhase: next.editorial_state?.phase, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, versionSummaries: sessionV3VersionSummaries(next, { turnId: input.turnId }) };
        }});
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (url.pathname.startsWith("/api/")) { sendJson(response, 404, { ok: false, code: "not_found", message: "API not found.", retryable: false }); return; }
      const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      let filePath = path.resolve(uiDirectory, requested);
      const sharedAsset = requested === "copy-catalog.js"
        ? path.resolve(root, "ui", "copy-catalog.js")
        : requested.startsWith("assets/") ? path.resolve(root, "ui", "v0-3", requested) : null;
      if ((!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) && sharedAsset && fs.existsSync(sharedAsset)) filePath = sharedAsset;
      if ((!filePath.startsWith(`${uiDirectory}${path.sep}`) && !(sharedAsset && filePath === sharedAsset)) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { sendJson(response, 404, { error: "Not found" }); return; }
      sendFile(response, filePath);
    } catch (error) {
      const failure = publicError(error);
      logEvent({ type: "request_failed", path: url.pathname, method: request.method, errorCode: failure.payload.code, status: failure.status });
      if (!response.writableEnded) sendJson(response, failure.status, failure.payload);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = "127.0.0.1";
  const port = Number(process.env.PORT || 4174);
  createOzInblogServer().listen(port, host, () => process.stderr.write(`oz-inblog v1.0a listening on http://${host}:${port}\n`));
}
