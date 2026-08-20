import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  bytes,
  changedFields,
  clone,
  promptParts,
  redactTraceValue,
  safeSegment,
  stateProjection,
  timingSummary,
  tokenSummary,
  writeJson,
  writeText
} from "./oz-brunch-debug-trace-utils.mjs";

export function debugTraceSessionSegment(value) {
  return safeSegment(value, "session");
}

export function isDebugTraceEnabled(env = process.env) {
  return String(env.OZ_BRUNCH_DEBUG_TRACE ?? "") === "1";
}

function now() {
  return new Date().toISOString();
}

function actualStageNames(logs) {
  return logs.filter((event) => event?.type === "stage_started").map((event) => event.stage).filter(Boolean);
}

function responseSummary(response) {
  return response && typeof response === "object"
    ? { markdownBytes: bytes(response.markdown), question: response.question ?? null, choiceCount: Array.isArray(response.choices) ? response.choices.length : 0 }
    : null;
}

export class BrunchDebugTraceRecorder {
  constructor({ root, sessionId, manifest = {}, enabled = isDebugTraceEnabled(), debugDirectory = process.env.OZ_BRUNCH_DEBUG_DIR } = {}) {
    this.enabled = enabled === true;
    this.root = root;
    this.sessionId = sessionId;
    this.traceId = manifest.traceId ?? `trace-${crypto.randomUUID()}`;
    this.startedAt = manifest.startedAt ?? now();
    this.baseDirectory = debugDirectory
      ? path.join(path.resolve(debugDirectory), debugTraceSessionSegment(sessionId))
      : path.join(root, "output", "debug", "runs", debugTraceSessionSegment(sessionId));
    this.directory = path.join(this.baseDirectory, `.pending-${safeSegment(this.traceId)}`);
    this.logs = [];
    this.errors = [];
    this.calls = [];
    this.stateBefore = null;
    this.statePatches = [];
    this.stateAfter = null;
    this.discoveryDiagnostics = null;
    this.manifest = {
      ...redactTraceValue(manifest),
      sessionId,
      traceId: this.traceId,
      runtimeProfile: manifest.runtimeProfile ?? "v1.0a",
      startedAt: this.startedAt,
      completedAt: null,
      status: "running"
    };
    if (this.enabled) {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeJson(path.join(this.directory, "manifest.json"), this.manifest);
    }
  }

  recordLog(event) {
    if (!this.enabled || !event) return;
    this.logs.push(redactTraceValue({ ...clone(event), observedAt: event.observedAt ?? now() }));
  }

  recordError(error, context = {}) {
    if (!this.enabled) return;
    this.errors.push(redactTraceValue({
      ...context,
      code: error?.code ?? context.code ?? "unknown",
      message: error?.message ?? String(error),
      observedAt: now()
    }));
  }

  recordStateBefore(editorialState, evidenceBundle, stateRevision = null) {
    if (!this.enabled) return;
    this.stateBefore = stateProjection(editorialState, evidenceBundle, stateRevision);
  }

  recordStateAfter(editorialState, evidenceBundle, stateRevision = null, reason = "state_update") {
    if (!this.enabled) return;
    const after = stateProjection(editorialState, evidenceBundle, stateRevision);
    this.statePatches.push({ reason, patch: changedFields(this.stateBefore ?? {}, after, reason), before: this.stateBefore, after });
    this.stateAfter = after;
  }

  recordCall({ stage, prompt, raw, parsed, execution } = {}) {
    if (!this.enabled) return;
    const index = this.calls.length + 1;
    const directory = path.join(this.directory, "calls", `${String(index).padStart(2, "0")}-${safeSegment(stage)}`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const safePrompt = redactTraceValue(String(prompt ?? ""));
    const safeRaw = redactTraceValue(String(raw ?? ""));
    const safeParsed = redactTraceValue(parsed ?? null);
    writeJson(path.join(directory, "input-summary.json"), {
      stage: stage ?? "unknown",
      promptBytes: bytes(prompt),
      contextParts: promptParts(prompt),
      model: execution?.model ?? null,
      reasoningEffort: execution?.reasoningEffort ?? null
    });
    writeText(path.join(directory, "prompt.txt"), safePrompt);
    writeText(path.join(directory, "output-raw.txt"), safeRaw);
    writeJson(path.join(directory, "output-parsed.json"), safeParsed);
    writeJson(path.join(directory, "metadata.json"), {
      stage: stage ?? "unknown",
      model: execution?.model ?? null,
      reasoningEffort: execution?.reasoningEffort ?? null,
      durationMs: execution?.durationMs ?? null,
      exitCode: execution?.code ?? null,
      timedOut: execution?.timedOut === true,
      cancelled: execution?.cancelled === true,
      tokenUsage: tokenSummary(this.logs, execution?.tokenUsage)
    });
    this.calls.push({
      stage: stage ?? "unknown",
      directory,
      promptBytes: bytes(prompt),
      rawBytes: bytes(raw),
      durationMs: execution?.durationMs ?? null,
      tokenUsage: tokenSummary(this.logs, execution?.tokenUsage)
    });
  }

  recordDiscoveryDiagnostics(value) {
    if (!this.enabled || !value || typeof value !== "object") return;
    this.discoveryDiagnostics = redactTraceValue(clone(value));
  }

  finalize({ status = "completed", turnId = null, phaseAfter = null, metadata = null, response = null, error = null } = {}) {
    if (!this.enabled) return null;
    const finalStatus = ["failed", "aborted"].includes(status) ? status : "completed";
    this.stateAfter ??= this.stateBefore;
    const finalDirectory = path.join(this.baseDirectory, safeSegment(turnId, safeSegment(this.traceId)));
    fs.mkdirSync(this.baseDirectory, { recursive: true, mode: 0o700 });
    if (this.directory !== finalDirectory) {
      if (fs.existsSync(finalDirectory)) fs.rmSync(finalDirectory, { recursive: true, force: true });
      fs.renameSync(this.directory, finalDirectory);
      this.directory = finalDirectory;
    }
    this.manifest = {
      ...this.manifest,
      turnId,
      phaseAfter,
      completedAt: now(),
      durationMs: metadata?.durationMs ?? Date.now() - Date.parse(this.startedAt),
      status: finalStatus
    };
    writeJson(path.join(this.directory, "manifest.json"), this.manifest);
    writeJson(path.join(this.directory, "route.json"), this.route({ status: finalStatus, metadata }));
    writeJson(path.join(this.directory, "state.json"), { before: this.stateBefore, patches: this.statePatches, after: this.stateAfter });
    writeJson(path.join(this.directory, "events.json"), { events: this.logs });
    if (this.discoveryDiagnostics) writeJson(path.join(this.directory, "discovery.json"), this.discoveryDiagnostics);
    writeJson(path.join(this.directory, "search-ledger.json"), {
      events: this.logs.filter((event) => event.type === "app_server_search_event"),
      resultCount: "unknown",
      openedUrls: "unknown",
      note: "Only App Server search notifications are recorded; unavailable fields remain unknown."
    });
    writeJson(path.join(this.directory, "errors.json"), { errors: this.errors, finalError: error ? redactTraceValue(error) : null });
    writeText(path.join(this.directory, "summary.md"), this.summary({ metadata, response, status: finalStatus }));
    return this.directory;
  }

  route({ status, metadata }) {
    const actualStages = actualStageNames(this.logs);
    const plannedStages = Array.isArray(this.manifest.plannedStages) ? this.manifest.plannedStages : [];
    return {
      phaseBefore: this.manifest.phaseBefore ?? null,
      phaseAfter: this.manifest.phaseAfter ?? null,
      intent: this.manifest.intent ?? null,
      operation: this.manifest.operation ?? null,
      plannedStages,
      actualStages,
      skippedStages: plannedStages.filter((stage) => !actualStages.includes(stage)),
      retry: { occurred: this.logs.some((event) => /retry|fallback|finish_requested/iu.test(String(event.type ?? ""))) },
      steer: { occurred: this.logs.some((event) => /steer/iu.test(String(event.type ?? ""))) },
      abort: { occurred: status === "aborted" || this.logs.some((event) => event.type === "generation_interrupt_requested") },
      durationMs: metadata?.durationMs ?? null
    };
  }

  summary({ metadata, response, status }) {
    const stageLines = this.calls.length
      ? this.calls.map((call) => `- ${call.stage}: prompt ${call.promptBytes} bytes, duration ${call.durationMs ?? "unknown"} ms, last tokens ${JSON.stringify(call.tokenUsage.last)}`).join("\n")
      : "- none";
    const searchEvents = this.logs.filter((event) => event.type === "app_server_search_event");
    const tokenEvents = this.logs.filter((event) => event.type === "app_server_token_usage");
    return [
      `# Brunch Turn Debug Summary (${this.manifest.runtimeProfile ?? "v1.0a"})`,
      "",
      "## User",
      this.manifest.userInput ?? "",
      "",
      "## Route",
      `${this.manifest.phaseBefore ?? "unknown"} → ${this.manifest.phaseAfter ?? "unknown"}`,
      `Stages: ${actualStageNames(this.logs).join(" → ") || "none"}`,
      "",
      "## Calls",
      stageLines,
      "",
      "## State",
      `article_ready: ${String(this.stateAfter?.articleReady ?? "unknown")}`,
      `state revision: ${this.stateBefore?.stateRevision ?? "unknown"} → ${this.stateAfter?.stateRevision ?? "unknown"}`,
      "",
      "## Events",
      `search events: ${searchEvents.length}`,
      `token usage notifications: ${tokenEvents.length}`,
      ...(this.discoveryDiagnostics ? [
        "",
        "## Curated Discovery",
        `finish reason: ${this.discoveryDiagnostics.finishReason ?? "unknown"}`,
        `article opens: ${this.discoveryDiagnostics.articleOpenCount ?? "unknown"}`,
        `source checks: ${this.discoveryDiagnostics.sourceChecksAttempted ?? "unknown"}/${this.discoveryDiagnostics.sourceChecksTotal ?? "unknown"}`,
        `seed candidates: ${this.discoveryDiagnostics.seedCandidateCount ?? "unknown"}`,
        `candidate quality exclusions: ${this.discoveryDiagnostics.candidateQualityExclusions?.length ?? "unknown"}`,
        `archive duplicate exclusions: ${this.discoveryDiagnostics.archiveDuplicateExclusions ?? "unknown"}`
      ] : []),
      "",
      "## Duration",
      `${metadata?.durationMs ?? "unknown"} ms`,
      "",
      `Status: ${status}`,
      `Response: ${JSON.stringify(responseSummary(response))}`
    ].join("\n");
  }
}

export function createDebugTurnRecorder(options = {}) {
  return new BrunchDebugTraceRecorder(options);
}
