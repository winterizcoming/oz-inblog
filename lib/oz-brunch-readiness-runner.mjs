import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  BrunchSkillError,
  createFileSessionStore,
  hashBrunchMarkdown,
  normalizeWritingPreview,
  withBrunchSessionLock
} from "./oz-inblog-runner.mjs";
import { findSessionV3Turn, findSessionV3Version, migrateSessionToV3, sessionV3Metadata } from "./oz-brunch-session-v3.mjs";
import { loadSkillBundle } from "./oz-inblog-runner.mjs";
import { buildBrunchReadinessPrompt } from "./oz-brunch-readiness-prompt.mjs";

export { buildBrunchReadinessPrompt } from "./oz-brunch-readiness-prompt.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BRUNCH_READINESS_TIMEOUT_MS = 180_000;
export const BRUNCH_READINESS_RUBRIC_VERSION = "9";
export const BRUNCH_READINESS_MODEL = Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high" });
export const BRUNCH_READINESS_DIMENSIONS = Object.freeze([
  "central_judgment",
  "title_contract",
  "structure_conclusion",
  "evidence_boundaries",
  "voice_readability"
]);
export const BRUNCH_READINESS_BLOCKER_SEVERITY = Object.freeze({
  TITLE_CONTRACT_MISMATCH: "advisory",
  CENTRAL_JUDGMENT_MISSING: "advisory",
  CONCLUSION_MISSING: "advisory",
  EXCESSIVE_REPETITION: "advisory",
  SOURCE_ATTRIBUTION_INCOMPLETE: "advisory",
  COPYEDITING_REQUIRED: "advisory",
  UNVERIFIED_NUMERIC_CLAIM: "critical",
  UNSUPPORTED_CLAIM: "critical",
  SOURCE_CLAIM_MISMATCH: "critical"
});

const schemaPath = path.join(DEFAULT_ROOT, "schema", "brunch-writing-readiness.schema.json");
const readinessSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const validateReadinessSchema = new Ajv2020({ allErrors: true, strict: false }).compile(readinessSchema);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrunchSkillError("invalid_request", `${field} is required.`, { status: 422, fieldErrors: { [field]: `${field} is required.` } });
  }
  return value.trim();
}

function errorFromExecution(execution) {
  if (execution?.timedOut) return new BrunchSkillError("timeout", "Writing readiness evaluation timed out.", { status: 504, retryable: true });
  if (execution?.cancelled) return new BrunchSkillError("cancelled", "Writing readiness evaluation was cancelled.", { status: 499, retryable: true });
  return new BrunchSkillError("readiness_failed", "Writing readiness evaluation failed.", { status: 502, retryable: true });
}

export function buildBrunchReadinessOutputSchema() {
  return clone(readinessSchema);
}

export function validateReadinessInput(input) {
  const allowed = new Set(["sessionId", "turnId", "versionId", "previewHash"]);
  const unknown = Object.keys(input ?? {}).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new BrunchSkillError("invalid_request", `Unknown fields: ${unknown.join(", ")}`, { status: 422, fieldErrors: { unknown: `Unknown fields: ${unknown.join(", ")}` } });
  }
  const sessionId = nonEmptyString(input?.sessionId, "sessionId");
  if (sessionId.length > 256) throw new BrunchSkillError("invalid_request", "sessionId must be 256 characters or fewer.", { status: 422, fieldErrors: { sessionId: "sessionId must be 256 characters or fewer." } });
  const turnId = nonEmptyString(input?.turnId, "turnId");
  const versionId = nonEmptyString(input?.versionId, "versionId");
  const previewHash = nonEmptyString(input?.previewHash, "previewHash").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(previewHash)) throw new BrunchSkillError("invalid_request", "previewHash must be a SHA-256 hash.", { status: 422, fieldErrors: { previewHash: "previewHash must be a SHA-256 hash." } });
  return { sessionId, turnId, versionId, previewHash };
}

function targetPreview(record, input) {
  const versioned = migrateSessionToV3({ ...record, sessionId: record.sessionId ?? input.sessionId }, { sessionId: input.sessionId });
  const turn = findSessionV3Turn(versioned, input.turnId);
  const version = findSessionV3Version(turn, input.versionId);
  const branch = versioned.branches.find((entry) => entry.branchId === versioned.activeBranchId);
  const selectedVersionId = branch?.versionSelections?.[input.turnId] ?? turn?.activeVersionId;
  if (!turn || !version || !branch || !branch.turnIds.includes(input.turnId) || selectedVersionId !== input.versionId) {
    throw new BrunchSkillError("invalid_request", "The requested writing preview version is not active.", { status: 422, fieldErrors: { versionId: "versionId is not active." } });
  }
  const preview = normalizeWritingPreview(version.content?.writing_preview);
  if (!preview) throw new BrunchSkillError("invalid_request", "The selected assistant version has no writing preview.", { status: 422, fieldErrors: { versionId: "writing_preview is required." } });
  const currentHash = hashBrunchMarkdown(preview.markdown);
  if (currentHash !== input.previewHash) throw new BrunchSkillError("preview_conflict", "The writing preview changed before it could be evaluated.", { status: 409, retryable: true });
  return { versioned, turn, version, preview, branch, currentHash };
}

function readinessCacheMatches(value, input) {
  return value
    && typeof value === "object"
    && value.previewHash === input.previewHash
    && value.rubricVersion === BRUNCH_READINESS_RUBRIC_VERSION
    && value.model === BRUNCH_READINESS_MODEL.model
    && value.reasoningEffort === BRUNCH_READINESS_MODEL.reasoningEffort
    && typeof value.band === "string";
}

export function calculateReadinessBand(result) {
  const dimensions = Array.isArray(result?.dimensions) ? result.dimensions : [];
  const scores = new Map(dimensions.map((dimension) => [dimension.id, dimension.score]));
  const criticalBlocker = result?.blockers?.some((blocker) => blocker.severity === "critical") ?? false;
  const blockerCodes = new Set((result?.blockers ?? []).map((blocker) => blocker.code));
  const compoundAuthorshipFailure = blockerCodes.has("CENTRAL_JUDGMENT_MISSING")
    && blockerCodes.has("CONCLUSION_MISSING")
    && scores.get("central_judgment") <= 2
    && scores.get("structure_conclusion") <= 2;
  if (criticalBlocker || scores.get("evidence_boundaries") === 1 || compoundAuthorshipFailure) return "needs_work";
  if (result?.confidence !== "low"
    && result?.evidence_status !== "needs_verification"
    && (result?.blockers?.length ?? 0) === 0
    && BRUNCH_READINESS_DIMENSIONS.filter((id) => id !== "voice_readability").every((id) => scores.get(id) >= 4)
    && scores.get("voice_readability") >= 3) return "ready";
  return "almost_ready";
}

export function normalizeReadinessResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !validateReadinessSchema(value)) {
    throw new BrunchSkillError("invalid_readiness_response", "Writing readiness evaluation returned an invalid result.", { status: 502, retryable: true });
  }
  const seen = new Set();
  const dimensions = value.dimensions.map((dimension) => {
    if (seen.has(dimension.id)) throw new BrunchSkillError("invalid_readiness_response", "Writing readiness evaluation returned a duplicate dimension.", { status: 502, retryable: true });
    seen.add(dimension.id);
    return { id: dimension.id, score: dimension.score, reason: dimension.reason.trim() };
  });
  if (seen.size !== BRUNCH_READINESS_DIMENSIONS.length || BRUNCH_READINESS_DIMENSIONS.some((id) => !seen.has(id))) {
    throw new BrunchSkillError("invalid_readiness_response", "Writing readiness evaluation did not return all required dimensions.", { status: 502, retryable: true });
  }
  const normalized = {
    dimensions,
    blockers: value.blockers.map((blocker) => ({
      code: blocker.code.trim(),
      severity: BRUNCH_READINESS_BLOCKER_SEVERITY[blocker.code],
      message: blocker.message.trim(),
      action: blocker.action.trim()
    })),
    evidence_status: value.evidence_status,
    confidence: value.confidence,
    summary: value.summary.trim()
  };
  return { ...normalized, band: calculateReadinessBand(normalized) };
}

function rawFromExecution(execution) {
  return execution?.raw ?? execution?.stdout ?? "";
}

function readinessMetadata(result, input, execution, cached = false) {
  return {
    previewHash: input.previewHash,
    rubricVersion: BRUNCH_READINESS_RUBRIC_VERSION,
    model: BRUNCH_READINESS_MODEL.model,
    reasoningEffort: BRUNCH_READINESS_MODEL.reasoningEffort,
    evaluatedAt: new Date().toISOString(),
    durationMs: execution?.durationMs ?? 0,
    cached
  };
}

async function readSnapshot({ sessionStore, input }) {
  return withBrunchSessionLock({ sessionStore, sessionId: input.sessionId, operation: async () => {
    const record = await sessionStore.read(input.sessionId);
    const target = targetPreview(record, input);
    return { record: target.versioned, target, revision: record.revision };
  }});
}

export async function evaluateBrunchWritingReadiness({
  root = DEFAULT_ROOT,
  sessionId,
  turnId,
  versionId,
  previewHash,
  sessionStore = createFileSessionStore({ root }),
  executionTransport,
  signal,
  timeoutMs = BRUNCH_READINESS_TIMEOUT_MS,
  onLog
} = {}) {
  const input = validateReadinessInput({ sessionId, turnId, versionId, previewHash });
  if (!executionTransport || typeof executionTransport.executeTurn !== "function") {
    throw new BrunchSkillError("invalid_request", "Writing readiness evaluation requires an App Server transport.", { status: 501, retryable: false });
  }
  const snapshot = await readSnapshot({ sessionStore, input });
  const cached = snapshot.target.version.writingReadiness;
  if (readinessCacheMatches(cached, input)) {
    return { readiness: clone(cached), metadata: readinessMetadata(cached, input, { durationMs: 0 }, true) };
  }

  let bundle;
  try {
    bundle = loadSkillBundle(root);
  } catch (error) {
    throw new BrunchSkillError("skill_unavailable", "Brunch editorial rubric could not be loaded for readiness evaluation.", { status: 503, retryable: false, cause: error });
  }
  const prompt = buildBrunchReadinessPrompt({ preview: snapshot.target.preview, bundle, evidenceBundle: snapshot.record.evidence_bundle });
  const startedAt = Date.now();
  onLog?.({ type: "readiness_started", sessionKey: hashBrunchMarkdown(input.sessionId).slice(0, 16), turnId: input.turnId, versionId: input.versionId, model: BRUNCH_READINESS_MODEL.model, reasoningEffort: BRUNCH_READINESS_MODEL.reasoningEffort });
  const execution = await executionTransport.executeTurn({
    root,
    prompt,
    outputSchema: buildBrunchReadinessOutputSchema(),
    signal,
    timeoutMs,
    model: BRUNCH_READINESS_MODEL.model,
    reasoningEffort: BRUNCH_READINESS_MODEL.reasoningEffort,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    onEvent: onLog
  });
  if (!execution || execution.code !== 0) throw errorFromExecution(execution);
  let normalized;
  try {
    normalized = normalizeReadinessResult(JSON.parse(String(rawFromExecution(execution)).trim()));
  } catch (error) {
    if (error instanceof BrunchSkillError) throw error;
    throw new BrunchSkillError("invalid_readiness_response", "Writing readiness evaluation did not return valid JSON.", { status: 502, retryable: true });
  }
  const metadata = readinessMetadata(normalized, input, { durationMs: execution.durationMs ?? Date.now() - startedAt });
  const stored = { ...normalized, ...metadata };

  await withBrunchSessionLock({ sessionStore, sessionId: input.sessionId, operation: async () => {
    const current = await sessionStore.read(input.sessionId);
    const target = targetPreview(current, input);
    const latestHash = hashBrunchMarkdown(target.preview.markdown);
    if (latestHash !== input.previewHash) throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being evaluated.", { status: 409, retryable: true });
    target.version.writingReadiness = clone(stored);
    target.versioned.messages = target.versioned.messages ?? [];
    target.versioned.messages = target.versioned.messages.length ? target.versioned.messages : current.messages;
    await sessionStore.write(input.sessionId, target.versioned.messages, sessionV3Metadata(target.versioned));
  }});
  onLog?.({ type: "readiness_finished", sessionKey: hashBrunchMarkdown(input.sessionId).slice(0, 16), turnId: input.turnId, versionId: input.versionId, model: BRUNCH_READINESS_MODEL.model, reasoningEffort: BRUNCH_READINESS_MODEL.reasoningEffort, durationMs: metadata.durationMs, band: stored.band });
  return { readiness: stored, metadata };
}
