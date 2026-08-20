import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEX_PROVIDER_MODEL, CODEX_PROVIDER_REASONING_EFFORTS, extractLastJsonObject } from "../scripts/codex-provider-common.mjs";
import { addSessionV3AssistantVersion, appendSessionV3Turn, findSessionV3Version, findSessionV3Turn, isSessionV3, migrateSessionToV3, replaceSessionV3Preview, sessionV3Metadata, sessionV3TargetForMessageIndex, sessionV3TurnHistory } from "./oz-brunch-session-v3.mjs";
import { buildSourceDiscoveryAppServerOutputSchema, normalizeSourceDiscoveryBundle, parseSourceDiscoveryResponse } from "./oz-brunch-source-discovery.mjs";
import { archiveContextForPrompt, fetchBrunchLiveArchive } from "./oz-brunch-live-archive.mjs";
import { BRUNCH_DEFAULT_MODEL_POLICY } from "./oz-brunch-models.mjs";
import { buildAppServerOutputSchema, normalizeResponse, normalizeWritingPreview, parseModelResponse } from "./oz-brunch-response.mjs";
import { BRUNCH_FINISH_GRACE, createBrunchTurnBudget, stageTimeoutsForBrunchOperation, timeoutForBrunchOperation } from "./oz-brunch-turn-budget.mjs";
import { createDebugTurnRecorder, isDebugTraceEnabled } from "./oz-brunch-debug-trace.mjs";
import { buildCuratedDiscoveryAppServerOutputSchema, buildCuratedDiscoveryEditPrompt, buildCuratedDiscoveryPrompt, buildCuratedEditAppServerOutputSchema, buildCuratedResearchAppServerOutputSchema, buildCuratedResearchPrompt, buildCuratedResearchResponsePrompt, buildCuratedResearchSourcePrompt, dedupeCuratedSeedsAgainstArchive, normalizeCuratedConversationResponse, normalizeCuratedDiscoveryResponse, normalizeCuratedOutlineResponse, parseCuratedDiscoveryResponse, parseCuratedEditResponse, parseCuratedResearchResponse, validateCuratedCandidateFit } from "./oz-brunch-curated-discovery.mjs";
import { CURATED_DISCOVERY_RUNTIME_PROFILE } from "./oz-brunch-runtime-profile.mjs";
import { curatedDiscoverySourcePoolForLane } from "./oz-brunch-discovery-sources.mjs";

import { buildArticlePrompt, buildOpenEditingPrompt, buildOutlinePrompt } from "./oz-inblog-writing-prompts.mjs";

export { buildAppServerOutputSchema, normalizeResponse, normalizeWritingPreview, parseModelResponse } from "./oz-brunch-response.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SESSION_DIRECTORY = path.join(DEFAULT_ROOT, ".tmp", "oz-brunch-skill-chat-sessions");
export const BRUNCH_SKILL_TIMEOUT_MS = 180_000;
export const BRUNCH_PIPELINE_POLICY = BRUNCH_DEFAULT_MODEL_POLICY;
const FINISH_REQUESTS = Object.freeze({
  source_discovery: "추가 검색을 중단하고 지금까지 실제로 확인한 원문과 검색 결과만으로 source discovery JSON을 완성하세요.",
  research: "현재 확보한 출처만 사용해 근거 장부를 완성하세요. 확인하지 못한 항목은 자료 공백으로 표시하고 추가 조사를 시작하지 마세요.",
  edit: "현재 확보한 근거와 사용자 요청으로 최종 응답 JSON을 완성하세요. 새로운 조사나 논점을 시작하지 마세요.",
  review: "추가 검토를 중단하고 현재 결과를 보존한 유효한 응답 JSON을 즉시 반환하세요."
});

const STAGE_ACTIVITIES = Object.freeze({
  topic_discovery: { source_discovery: "topic_searching", edit: "candidate_editing" },
  topic_retry: { source_discovery: "topic_searching", edit: "candidate_editing" },
  curated_topic_discovery: { source_discovery: "topic_searching", edit: "candidate_editing" },
  curated_topic_research: { source_discovery: "topic_source_searching", research: "evidence_synthesizing", edit: "direction_editing" },
  curated_conversation: { edit: "direction_editing" },
  topic_research: { source_discovery: "topic_source_searching", research: "evidence_synthesizing", edit: "direction_editing" },
  outline: { edit: "outline_editing" },
  article: { edit: "article_writing" },
  open_editing: { source_discovery: "topic_source_searching", research: "evidence_synthesizing", edit: "local_editing" },
  evidence_update: { source_discovery: "topic_source_searching", research: "evidence_synthesizing", edit: "local_editing" },
  local_edit: { edit: "local_editing" },
  structural_edit: { edit: "structural_editing" },
  full_rewrite: { edit: "full_rewriting" }
});

function stageActivity(operation, stage) {
  return STAGE_ACTIVITIES[operation]?.[stage] ?? (stage === "research" ? "evidence_synthesizing" : stage === "source_discovery" ? "topic_searching" : stage === "edit" ? "local_editing" : "finishing_response");
}

function ensureTopicRetryChoice(response) {
  if (!response || !Array.isArray(response.choices)) return response;
  const retryLabel = "모두 별로예요. 다시 찾아주세요";
  if (response.choices.some((choice) => choice?.label === retryLabel)) return response;
  return normalizeResponse({
    ...response,
    choices: [...response.choices, { label: retryLabel, description: "이 후보들을 제외하고 다른 최신 글감을 다시 찾습니다." }],
    question: response.question || "어떤 글감으로 이어갈까요?"
  });
}

function emitProgress(onProgress, event) {
  if (typeof onProgress === "function") onProgress({ ...event, timestamp: new Date().toISOString() });
}
const EVIDENCE_CASE_TYPES = new Set([
  "job_integration",
  "title_broadening",
  "organization_reframing",
  "role_expansion",
  "hybrid_role_creation",
  "historical_precedent",
  "near_miss"
]);
const EVIDENCE_CASE_RELATIONS = new Set([
  "anchor",
  "comparison",
  "counterexample",
  "counter_reading",
  "historical_precedent",
  "near_miss",
  "unclassified"
]);
const activeSessionLocks = new Map();
const curatedPipelineContexts = new Map();

async function acquireCuratedPipelineContext({ sessionId, executionTransport, model, root, cwd = root }) {
  const key = safeSessionId(sessionId);
  const existing = curatedPipelineContexts.get(key);
  if (existing?.model === model && existing.executionTransport === executionTransport) {
    existing.lastUsedAt = Date.now();
    return { context: existing.context, reused: true };
  }
  if (existing) {
    try { await existing.context.close(); } catch { /* Best-effort cleanup before replacing an experiment thread. */ }
    curatedPipelineContexts.delete(key);
  }
  const context = await executionTransport.beginPipeline({ model, cwd, ephemeral: true });
  curatedPipelineContexts.set(key, { context, executionTransport, model, lastUsedAt: Date.now() });
  return { context, reused: false };
}

async function releaseCuratedPipelineContext(sessionId, context) {
  const key = safeSessionId(sessionId);
  const current = curatedPipelineContexts.get(key);
  if (!current || current.context !== context) return;
  curatedPipelineContexts.delete(key);
  try { await context.close(); } catch { /* Best-effort cleanup after a failed or cancelled experiment turn. */ }
}

export function buildEvidenceAppServerOutputSchema() {
  const text = () => ({ type: "string" });
  const nullableText = () => ({ type: ["string", "null"] });
  const textList = () => ({ type: "array", items: text() });
  const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  });
  const list = (items) => ({ type: "array", items });
  const sourcedStatement = (extra = {}) => object({
    statement: text(),
    source_refs: textList(),
    ...extra
  });

  return object({
    topic: text(),
    core_question: text(),
    checked_at: text(),
    anchor_sources: list(object({
      id: text(),
      url: text(),
      title: text(),
      published_at: nullableText(),
      source_kind: text(),
      source_confidence: text(),
      verified: { type: "boolean" }
    })),
    claims: list(sourcedStatement({
      id: text(),
      kind: text(),
      support: text()
    })),
    cases: list(object({
      id: text(),
      name: text(),
      relation_to_anchor: { type: "string", enum: [...EVIDENCE_CASE_RELATIONS] },
      mechanism: text(),
      temporal_role: text(),
      similarities: textList(),
      differences: textList(),
      source_refs: textList(),
      editorial_uses: textList()
    })),
    signature_evidence: list(object({
      id: text(),
      type: text(),
      content: text(),
      source_ref: text(),
      editorial_role: text()
    })),
    tensions: list(object({
      id: text(),
      side_a: text(),
      side_b: text(),
      evidence_refs: textList()
    })),
    trend_evidence: list(sourcedStatement({ period: nullableText() })),
    counterevidence: list(sourcedStatement({ kind: nullableText() })),
    evidence_gaps: textList(),
    unsupported_claims: textList(),
    archive_comparison: object({
      status: text(),
      compared_refs: textList(),
      rationale: text()
    }),
    possible_directions: list(object({
      id: text(),
      judgment: text(),
      evidence_refs: textList(),
      risk: text()
    })),
    sufficiency: object({
      ready: { type: "boolean" },
      missing: textList(),
      blocking_gaps: textList(),
      advisory_gaps: textList(),
      claim_checks: list(object({
        claim_id: text(),
        required: textList(),
        satisfied: { type: "boolean" }
      })),
      usable_claims: textList(),
      blocked_claims: textList()
    })
  });
}

export { removeAppServerNullableFields } from "./oz-brunch-transport-normalizer.mjs";

export class BrunchSkillError extends Error {
  constructor(code, message, { status = 500, retryable = false, fieldErrors = undefined, details = undefined } = {}) {
    super(message);
    this.name = "BrunchSkillError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

const BRUNCH_SESSION_ACCESS_PREFIX = "brunch-session:";
const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/u;

function sessionStorageKey(sessionId) {
  const value = String(sessionId ?? "");
  const opaqueKey = value.startsWith(BRUNCH_SESSION_ACCESS_PREFIX)
    ? value.slice(BRUNCH_SESSION_ACCESS_PREFIX.length)
    : "";
  return SESSION_KEY_PATTERN.test(opaqueKey) ? opaqueKey : hash(value);
}

function sessionAccessId(storageKey) {
  return `${BRUNCH_SESSION_ACCESS_PREFIX}${storageKey}`;
}

export function hashBrunchMarkdown(value) {
  return hash(value);
}

export function safeSessionId(sessionId) {
  return hash(sessionId).slice(0, 16);
}

export function validateTurnInput({ sessionId, message }) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const fieldErrors = {};
  if (!normalizedSessionId) fieldErrors.sessionId = "sessionId is required.";
  if (normalizedSessionId.length > 256) fieldErrors.sessionId = "sessionId must be 256 characters or fewer.";
  if (typeof message !== "string" || !message.trim()) fieldErrors.message = "message is required.";
  if (Object.keys(fieldErrors).length > 0) {
    throw new BrunchSkillError("invalid_request", "sessionId and a non-empty message are required.", { status: 422, fieldErrors });
  }
  return { sessionId: normalizedSessionId, message };
}

function validateBrunchInteraction(interaction, session, message) {
  if (interaction === null || interaction === undefined) return null;
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    throw new BrunchSkillError("invalid_request", "interaction must be an object.", { status: 422, retryable: false });
  }
  const allowed = new Set(["type", "sourceTurnId", "choiceIndex", "action"]);
  const unknown = Object.keys(interaction).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BrunchSkillError("invalid_request", "interaction contains unknown fields.", { status: 422, retryable: false, fieldErrors: { interaction: unknown.join(", ") } });
  if (interaction.action !== undefined && interaction.action !== "retry_topics") throw new BrunchSkillError("invalid_request", "interaction.action is invalid.", { status: 422, retryable: false });
  if (!["choice", "free_text"].includes(interaction.type)) throw new BrunchSkillError("invalid_request", "interaction.type is invalid.", { status: 422, retryable: false });
  if (interaction.type === "free_text") return { type: "free_text" };
  if (!Number.isInteger(interaction.choiceIndex) || interaction.choiceIndex < 0) throw new BrunchSkillError("invalid_request", "choiceIndex is required for a choice interaction.", { status: 422, retryable: false });
  if (interaction.sourceTurnId !== undefined && (typeof interaction.sourceTurnId !== "string" || !interaction.sourceTurnId.trim())) throw new BrunchSkillError("invalid_request", "sourceTurnId is invalid.", { status: 422, retryable: false });
  let savedChoice = null;
  if (interaction.sourceTurnId) {
    const versioned = migrateSessionToV3({ ...session, sessionId: session.sessionId ?? "" }, { sessionId: session.sessionId ?? "" });
    const turn = findSessionV3Turn(versioned, interaction.sourceTurnId);
    const version = findSessionV3Version(turn, turn?.activeVersionId);
    savedChoice = version?.content?.choices?.[interaction.choiceIndex] ?? null;
    if (!turn || !version || !Array.isArray(version.content?.choices) || !savedChoice) {
      throw new BrunchSkillError("invalid_request", "choice interaction does not match the saved response.", { status: 422, retryable: false });
    }
    if (String(savedChoice.label).trim() !== String(message ?? "").trim()) throw new BrunchSkillError("invalid_request", "choice interaction does not match the saved response.", { status: 422, retryable: false });
    if (interaction.action === "retry_topics" && String(savedChoice.label).trim() !== "모두 별로예요. 다시 찾아주세요") throw new BrunchSkillError("invalid_request", "retry_topics action does not match the saved response.", { status: 422, retryable: false });
  } else if (session.messages.length > 0) {
    const latestAssistant = [...session.messages].reverse().find((entry) => entry?.role === "assistant");
    const savedChoices = Array.isArray(latestAssistant?.content?.choices) ? latestAssistant.content.choices : [];
    savedChoice = savedChoices[interaction.choiceIndex] ?? null;
    if (!savedChoice || typeof savedChoice.label !== "string" || savedChoice.label.trim() !== String(message ?? "").trim()) {
      throw new BrunchSkillError("invalid_request", "choice interaction does not match the saved response.", { status: 422, retryable: false });
    }
    if (interaction.action === "retry_topics" && savedChoice.label.trim() !== "모두 별로예요. 다시 찾아주세요") throw new BrunchSkillError("invalid_request", "retry_topics action does not match the saved response.", { status: 422, retryable: false });
  } else if (interaction.choiceIndex > 2) {
    throw new BrunchSkillError("invalid_request", "welcome choice does not exist.", { status: 422, retryable: false });
  } else if (interaction.action === "retry_topics" && String(message ?? "").trim() !== "모두 별로예요. 다시 찾아주세요") {
    throw new BrunchSkillError("invalid_request", "retry_topics action does not match the welcome response.", { status: 422, retryable: false });
  }
  return {
    type: "choice",
    choiceIndex: interaction.choiceIndex,
    ...(typeof savedChoice?.label === "string" ? { choiceLabel: savedChoice.label } : { choiceLabel: String(message ?? "").trim() }),
    ...(interaction.sourceTurnId ? { sourceTurnId: interaction.sourceTurnId } : {}),
    ...(interaction.action === "retry_topics" ? { action: "retry_topics" } : {})
  };
}

function sessionMessageError(index, detail) {
  return new BrunchSkillError("session_corrupt", `Stored Brunch session message ${index} is invalid: ${detail}`, { status: 500, retryable: false });
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new BrunchSkillError("session_corrupt", "Stored Brunch session must contain a messages array.");
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role)) {
      throw sessionMessageError(index, "role must be user or assistant");
    }
    if (message.role === "user" && typeof message.content !== "string") {
      throw sessionMessageError(index, "user content must be a string");
    }
    if (message.role === "assistant") {
      if (!message.content || typeof message.content !== "object" || Array.isArray(message.content)) {
        throw sessionMessageError(index, "assistant content must be an object");
      }
      try {
        normalizeResponse(message.content);
      } catch (error) {
        throw sessionMessageError(index, error instanceof Error ? error.message : "assistant content does not match the Brunch response contract");
      }
    }
  });
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cloneSessionRecord(record) {
  const cloned = { messages: cloneValue(record?.messages ?? []) };
  if (record?.evidence_bundle !== undefined) cloned.evidence_bundle = cloneValue(record.evidence_bundle);
  if (record?.title_research_sources !== undefined) cloned.title_research_sources = cloneValue(record.title_research_sources);
  if (record?.editorial_state !== undefined) cloned.editorial_state = cloneValue(record.editorial_state);
  if (record?.sessionVersion !== undefined) cloned.sessionVersion = record.sessionVersion;
  if (record?.sessionId !== undefined) cloned.sessionId = record.sessionId;
  if (record?.defaultModelPreset !== undefined) cloned.defaultModelPreset = record.defaultModelPreset;
  if (record?.activeBranchId !== undefined) cloned.activeBranchId = record.activeBranchId;
  if (record?.branches !== undefined) cloned.branches = cloneValue(record.branches);
  if (record?.turns !== undefined) cloned.turns = cloneValue(record.turns);
  if (record?.runtimeProfile !== undefined) cloned.runtimeProfile = record.runtimeProfile;
  return cloned;
}

function cloneSession(messages) {
  return cloneValue(messages);
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return normalizeBrunchText(value).trim();
}

function normalizeEvidenceSource(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`anchor_sources ${index + 1} must be an object`);
  const verified = value.verified === true || value.full_text_verified === true;
  if (!verified || value.snippet_only === true || value.source_confidence === "snippet" || value.full_text_verified === false) {
    throw new Error(`anchor_sources ${index + 1}.verified must be true for an opened full-text source`);
  }
  return {
    ...cloneValue(value),
    url: nonEmptyString(value.url ?? value.original_url, `anchor_sources ${index + 1}.url`),
    title: nonEmptyString(value.title, `anchor_sources ${index + 1}.title`),
    ...(value.published_at !== undefined ? { published_at: nonEmptyString(value.published_at, `anchor_sources ${index + 1}.published_at`) } : {}),
    ...(value.source_kind !== undefined ? { source_kind: nonEmptyString(value.source_kind, `anchor_sources ${index + 1}.source_kind`) } : {}),
    ...(value.source_confidence !== undefined ? { source_confidence: nonEmptyString(value.source_confidence, `anchor_sources ${index + 1}.source_confidence`) } : {}),
    verified: true
  };
}

function normalizeEvidenceList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry === "string") return nonEmptyString(entry, `${field} ${index + 1}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${field} ${index + 1} must be an object or string`);
    const normalized = cloneValue(entry);
    if (normalized.statement !== undefined) normalized.statement = nonEmptyString(normalized.statement, `${field} ${index + 1}.statement`);
    if (normalized.source_refs !== undefined) {
      if (!Array.isArray(normalized.source_refs)) throw new Error(`${field} ${index + 1}.source_refs must be an array`);
      normalized.source_refs = normalized.source_refs.map((ref, refIndex) => nonEmptyString(ref, `${field} ${index + 1}.source_refs ${refIndex + 1}`));
    }
    return normalized;
  });
}

function hasNarrowableEvidence(bundle) {
  return bundle.anchor_sources.length > 0 && bundle.claims.some((claim) => (
    Array.isArray(claim?.source_refs)
    && claim.source_refs.length > 0
    && claim.support !== "unsupported"
  ));
}

export function normalizeEvidenceBundle(value, sufficiencyScope = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence bundle must be an object");
  const cases = normalizeEvidenceList(value.cases ?? [], "cases").map((entry, index) => {
    if (typeof entry === "string") throw new Error(`cases ${index + 1} must be an object`);
    const legacyType = EVIDENCE_CASE_TYPES.has(entry.type);
    const genericRelation = EVIDENCE_CASE_RELATIONS.has(entry.relation_to_anchor);
    if (!legacyType && !genericRelation) entry.relation_to_anchor = "unclassified";
    if (!entry.name) entry.name = entry.id ?? `case-${index + 1}`;
    if (legacyType && !entry.distinction) throw new Error(`cases ${index + 1}.distinction must be a non-empty string`);
    if (EVIDENCE_CASE_RELATIONS.has(entry.relation_to_anchor) && !entry.mechanism) {
      entry.mechanism = entry.distinction ?? entry.similarity ?? "자료에서 관계를 분류하지 못한 사례";
    }
    return entry;
  });
  const claimChecks = Array.isArray(value.sufficiency?.claim_checks)
    ? value.sufficiency.claim_checks.map((entry, index) => ({
      claim_id: nonEmptyString(entry?.claim_id, `sufficiency.claim_checks ${index + 1}.claim_id`),
      required: Array.isArray(entry?.required)
        ? entry.required.map((requirement, requirementIndex) => nonEmptyString(requirement, `sufficiency.claim_checks ${index + 1}.required ${requirementIndex + 1}`))
        : [],
      satisfied: entry?.satisfied === true
    }))
    : [];
  const legacyMissing = Array.isArray(value.sufficiency?.missing)
    ? value.sufficiency.missing.map((entry, index) => nonEmptyString(entry, `sufficiency.missing ${index + 1}`))
    : [];
  const hasExplicitGapRoles = Array.isArray(value.sufficiency?.blocking_gaps) || Array.isArray(value.sufficiency?.advisory_gaps);
  const bundle = {
    topic: nonEmptyString(value.topic, "topic"),
    core_question: nonEmptyString(value.core_question, "core_question"),
    checked_at: nonEmptyString(value.checked_at, "checked_at"),
    anchor_sources: (Array.isArray(value.anchor_sources) ? value.anchor_sources : []).map(normalizeEvidenceSource),
    claims: normalizeEvidenceList(value.claims, "claims"),
    cases,
    signature_evidence: normalizeEvidenceList(value.signature_evidence ?? [], "signature_evidence"),
    tensions: normalizeEvidenceList(value.tensions ?? [], "tensions"),
    trend_evidence: normalizeEvidenceList(value.trend_evidence ?? [], "trend_evidence"),
    counterevidence: normalizeEvidenceList(value.counterevidence ?? [], "counterevidence"),
    evidence_gaps: normalizeEvidenceList(value.evidence_gaps, "evidence_gaps"),
    unsupported_claims: normalizeEvidenceList(value.unsupported_claims, "unsupported_claims"),
    archive_comparison: cloneValue(value.archive_comparison),
    possible_directions: normalizeEvidenceList(value.possible_directions ?? [], "possible_directions"),
    sufficiency: {
      ready: value.sufficiency?.ready === true,
      missing: legacyMissing,
      blocking_gaps: Array.isArray(value.sufficiency?.blocking_gaps)
        ? value.sufficiency.blocking_gaps.map((entry, index) => nonEmptyString(entry, `sufficiency.blocking_gaps ${index + 1}`))
        : hasExplicitGapRoles ? [] : legacyMissing,
      advisory_gaps: Array.isArray(value.sufficiency?.advisory_gaps)
        ? value.sufficiency.advisory_gaps.map((entry, index) => nonEmptyString(entry, `sufficiency.advisory_gaps ${index + 1}`))
        : [],
      claim_checks: claimChecks,
      usable_claims: Array.isArray(value.sufficiency?.usable_claims)
        ? value.sufficiency.usable_claims.map((entry, index) => nonEmptyString(entry, `sufficiency.usable_claims ${index + 1}`))
        : [],
      blocked_claims: Array.isArray(value.sufficiency?.blocked_claims)
        ? value.sufficiency.blocked_claims.map((entry, index) => nonEmptyString(entry, `sufficiency.blocked_claims ${index + 1}`))
        : []
    }
  };
  if (!bundle.archive_comparison || typeof bundle.archive_comparison !== "object" || Array.isArray(bundle.archive_comparison)) {
    throw new Error("archive_comparison must be an object");
  }
  const assessed = assessEvidenceSufficiency(bundle, sufficiencyScope);
  bundle.sufficiency = { ...bundle.sufficiency, ...assessed };
  return bundle;
}

export function createMemorySessionStore() {
  const sessions = new Map();
  const namespace = `memory:${crypto.randomUUID()}`;
  return {
    namespace,
    lockKey: (sessionId) => `${namespace}:${safeSessionId(sessionId)}`,
    read: (sessionId) => cloneSessionRecord(sessions.get(sessionId) ?? { messages: [] }),
    write: (sessionId, messages, metadata = undefined) => {
      validateMessages(messages);
      const previous = sessions.get(sessionId) ?? { messages: [] };
      sessions.set(sessionId, cloneSessionRecord({
        messages,
        ...(metadata ?? {
          ...(previous.evidence_bundle !== undefined ? { evidence_bundle: previous.evidence_bundle } : {}),
          ...(previous.title_research_sources !== undefined ? { title_research_sources: previous.title_research_sources } : {}),
          ...(previous.editorial_state !== undefined ? { editorial_state: previous.editorial_state } : {}),
          ...(previous.sessionVersion !== undefined ? sessionV3Metadata(previous) : {})
        })
      }));
    },
    snapshot: (sessionId) => cloneSessionRecord(sessions.get(sessionId) ?? { messages: [] }),
    async list({ limit = 100 } = {}) {
      return [...sessions.entries()]
        .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100))
        .map(([sessionId, record]) => ({ sessionId, storageKey: sessionId, updatedAt: null, expiresAt: null, record: cloneSessionRecord(record) }));
    }
  };
}

export function createFileSessionStore({ root = DEFAULT_ROOT, directory = DEFAULT_SESSION_DIRECTORY, sessionPath = null } = {}) {
  const resolvedDirectory = path.resolve(root, directory);
  const fixedSessionPath = sessionPath ? path.resolve(sessionPath) : null;
  const namespace = `file:${fixedSessionPath ?? resolvedDirectory}`;
  const pathFor = (sessionId) => fixedSessionPath ?? path.join(resolvedDirectory, `${sessionStorageKey(sessionId)}.json`);

  return {
    namespace,
    pathFor,
    lockKey: (sessionId) => `${namespace}:${safeSessionId(sessionId)}`,
    read: (sessionId) => {
      const filePath = pathFor(sessionId);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level object is required");
        validateMessages(parsed.messages);
        const record = { messages: parsed.messages };
        if (parsed.evidence_bundle !== undefined) record.evidence_bundle = normalizeEvidenceBundle(parsed.evidence_bundle);
        if (parsed.title_research_sources !== undefined) record.title_research_sources = normalizeSourceDiscoveryBundle(parsed.title_research_sources);
        if (parsed.editorial_state !== undefined) record.editorial_state = cloneValue(parsed.editorial_state);
        if (parsed.runtimeProfile !== undefined) record.runtimeProfile = parsed.runtimeProfile;
        if (parsed.sessionVersion !== undefined) {
          record.sessionVersion = parsed.sessionVersion;
          record.sessionId = parsed.sessionId;
          record.defaultModelPreset = parsed.defaultModelPreset;
          record.runtimeProfile = parsed.runtimeProfile;
          record.activeBranchId = parsed.activeBranchId;
          record.branches = cloneValue(parsed.branches);
          record.turns = cloneValue(parsed.turns);
          if (!isSessionV3(record)) throw new BrunchSkillError("session_corrupt", "Stored Brunch session v3 metadata is invalid.", { status: 500, retryable: false });
        }
        return cloneSessionRecord(record);
      } catch (error) {
        if (error?.code === "ENOENT") return { messages: [] };
        if (error instanceof BrunchSkillError) throw error;
        throw new BrunchSkillError("session_corrupt", "Stored Brunch session is not valid JSON.", { status: 500, retryable: false });
      }
    },
    write: (sessionId, messages, metadata = undefined) => {
      validateMessages(messages);
      const previous = metadata === undefined ? (() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(pathFor(sessionId), "utf8"));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
          return error?.code === "ENOENT" ? {} : {};
        }
      })() : {};
      const record = {
        messages,
        ...(metadata ?? {
          ...(previous.evidence_bundle !== undefined ? { evidence_bundle: previous.evidence_bundle } : {}),
          ...(previous.title_research_sources !== undefined ? { title_research_sources: previous.title_research_sources } : {}),
          ...(previous.editorial_state !== undefined ? { editorial_state: previous.editorial_state } : {}),
          ...(previous.sessionVersion !== undefined ? sessionV3Metadata(previous) : {})
        })
      };
      if (record.evidence_bundle !== undefined) record.evidence_bundle = normalizeEvidenceBundle(record.evidence_bundle);
      if (record.title_research_sources !== undefined) record.title_research_sources = normalizeSourceDiscoveryBundle(record.title_research_sources);
      const filePath = pathFor(sessionId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        try { fs.unlinkSync(tempPath); } catch { /* Best-effort cleanup of this write's temp file. */ }
        throw new BrunchSkillError("session_write_failed", "Brunch session could not be saved.", { status: 500, retryable: true });
      }
    },
    async list({ limit = 100 } = {}) {
      if (fixedSessionPath || !fs.existsSync(resolvedDirectory)) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      return fs.readdirSync(resolvedDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && SESSION_KEY_PATTERN.test(entry.name.replace(/\.json$/u, "")) && entry.name.endsWith(".json"))
        .map((entry) => {
          const storageKey = entry.name.slice(0, -5);
          const filePath = path.join(resolvedDirectory, entry.name);
          try {
            const record = this.read(sessionAccessId(storageKey));
            const stats = fs.statSync(filePath);
            return { sessionId: sessionAccessId(storageKey), storageKey, updatedAt: stats.mtime.toISOString(), expiresAt: null, record };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
        .slice(0, max);
    }
  };
}

const SKILL_PATH = path.join(DEFAULT_ROOT, "skills", "oz-brunch-editorial-chat", "SKILL.md");
const REFERENCES_DIR = path.join(DEFAULT_ROOT, "skills", "oz-brunch-editorial-chat", "references");

export function loadSkillBundle(root = DEFAULT_ROOT) {
  const skillPath = path.join(root, "skills", "oz-brunch-editorial-chat", "SKILL.md");
  const referencesDirectory = path.join(root, "skills", "oz-brunch-editorial-chat", "references");
  let skill;
  try {
    skill = fs.readFileSync(skillPath, "utf8");
  } catch (error) {
    throw new BrunchSkillError("skill_unavailable", `Brunch Skill could not be read: ${error instanceof Error ? error.message : String(error)}`, { status: 500, retryable: false });
  }

  let entries;
  try {
    entries = fs.readdirSync(referencesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    throw new BrunchSkillError("skill_unavailable", `Brunch Skill references could not be read: ${error instanceof Error ? error.message : String(error)}`, { status: 500, retryable: false });
  }
  if (entries.length === 0) throw new BrunchSkillError("skill_unavailable", "Brunch Skill references directory contains no Markdown files.", { status: 500, retryable: false });

  const references = entries.map((entry) => {
    const filePath = path.join(referencesDirectory, entry.name);
    try {
      return { name: entry.name, path: filePath, content: fs.readFileSync(filePath, "utf8") };
    } catch (error) {
      throw new BrunchSkillError("skill_unavailable", `Brunch Skill reference could not be read: ${error instanceof Error ? error.message : String(error)}`, { status: 500, retryable: false });
    }
  });
  return { skill: { path: skillPath, content: skill }, references };
}

function parseEvidenceComponentResponse(raw, requiredFields, errorCode) {
  const text = String(raw ?? "").trim();
  let candidate = text;
  let parseMode = "json";
  try {
    JSON.parse(candidate);
  } catch {
    candidate = extractLastJsonObject(text);
    parseMode = "json-object";
  }
  try {
    const bundle = JSON.parse(candidate);
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("stage response must be an object");
    for (const field of requiredFields) {
      if (!(field in bundle)) throw new Error(`${field} is required`);
    }
    return {
      bundle: Object.fromEntries(requiredFields.map((field) => [field, bundle[field]])),
      parseMode,
      valid: true
    };
  } catch (error) {
    return { bundle: null, parseMode, valid: false, errorCode, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export function parseEvidenceResponse(raw) {
  const text = String(raw ?? "").trim();
  let candidate = text;
  let parseMode = "json";
  try {
    JSON.parse(candidate);
  } catch {
    candidate = extractLastJsonObject(text);
    parseMode = "json-object";
  }
  try {
    const parsed = JSON.parse(candidate);
    const bundle = normalizeEvidenceBundle(parsed?.evidence_bundle ?? parsed);
    return { bundle, parseMode, valid: true };
  } catch (error) {
    return {
      bundle: null,
      parseMode,
      valid: false,
      errorCode: "invalid_evidence_bundle",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export function shouldRefreshResearch(message) {
  const normalized = String(message ?? "").toLocaleLowerCase("ko-KR").trim();
  if (!normalized) return false;
  const existingEvidenceOnly = /(기존|현재|이미)\s*(?:에\s*)?(?:검증|확인)?(?:한|된)?\s*(근거|자료|출처)(?:만|로|를\s*사용)/u.test(normalized)
    || /(추가|새로운)\s*(조사|검색|자료|근거).*(하지\s*마|말고|불필요)/u.test(normalized)
    || /(조사|검색).*(하지\s*마|말고|불필요)/u.test(normalized);
  if (existingEvidenceOnly) return false;
  const titleOnly = /^(제목|부제|타이틀)(과|,|\s)*(부제|제목)?\s*(만|만요|만 바꿔|어휘|표현|수정)/u.test(normalized)
    || (/제목|부제|타이틀/u.test(normalized) && !/(사례|회사|근거|최신|현재|반론|논지|방향|원인|범위|자료|추가|결합|통합)/u.test(normalized));
  if (titleOnly) return false;
  return /(결합|합치|추가|새로운\s*(사례|회사|자료)|반론|반대|최신|시의성|현재성|범위\s*(확대|넓)|원인|근거\s*(부족|확인)|중심\s*(판단|논지)|방향\s*(변경|결합)|다른\s*회사|surfit|검색\s*(유입|어|결과)|클릭될|기존\s*제목|부제\s*(작성|후보))/u.test(normalized);
}

function mergeUniqueEvidence(previous = [], next = [], keyFor = (entry) => JSON.stringify(entry)) {
  const seen = new Set();
  return [...previous, ...next].filter((entry) => {
    const key = keyFor(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function replacesResearchTopic(message) {
  return /(새|다른)\s*주제|주제(?:를|는)?\s*(?:바꿔|변경|교체)|이번에는\s+.+(?:주제|글)/u.test(String(message ?? ""));
}

function mergeTargetedEvidence(previous, next, message, sufficiencyScope = {}) {
  if (!previous || replacesResearchTopic(message)) return next;
  return normalizeEvidenceBundle({
    ...next,
    topic: previous.topic,
    core_question: previous.core_question,
    anchor_sources: mergeUniqueEvidence(previous.anchor_sources, next.anchor_sources, (entry) => entry.url),
    claims: mergeUniqueEvidence(previous.claims, next.claims, (entry) => `${entry.statement}\u0000${entry.source_refs.join("\u0001")}`),
    cases: mergeUniqueEvidence(previous.cases, next.cases, (entry) => `${entry.name}\u0000${entry.type ?? entry.relation_to_anchor}\u0000${entry.source_refs.join("\u0001")}`),
    signature_evidence: mergeUniqueEvidence(previous.signature_evidence, next.signature_evidence),
    tensions: mergeUniqueEvidence(previous.tensions, next.tensions),
    trend_evidence: mergeUniqueEvidence(previous.trend_evidence, next.trend_evidence),
    counterevidence: mergeUniqueEvidence(previous.counterevidence, next.counterevidence),
    evidence_gaps: mergeUniqueEvidence(previous.evidence_gaps, next.evidence_gaps),
    unsupported_claims: mergeUniqueEvidence(previous.unsupported_claims, next.unsupported_claims),
    possible_directions: mergeUniqueEvidence(previous.possible_directions, next.possible_directions, (entry) => entry.judgment),
    archive_comparison: previous.archive_comparison,
    sufficiency: {
      ...next.sufficiency,
      missing: next.sufficiency.missing,
      blocking_gaps: next.sufficiency.blocking_gaps,
      advisory_gaps: mergeUniqueEvidence(
        [...(previous.sufficiency.advisory_gaps ?? []), ...(previous.sufficiency.missing ?? [])],
        next.sufficiency.advisory_gaps ?? []
      ),
      usable_claims: mergeUniqueEvidence(previous.sufficiency.usable_claims, next.sufficiency.usable_claims),
      blocked_claims: mergeUniqueEvidence(previous.sufficiency.blocked_claims, next.sufficiency.blocked_claims)
    }
  }, sufficiencyScope);
}

function sessionLockKey(sessionStore, sessionId) {
  return typeof sessionStore?.lockKey === "function"
    ? sessionStore.lockKey(sessionId)
    : `store:${safeSessionId(sessionId)}`;
}

export async function withBrunchSessionLock({ sessionStore, sessionId, operation }) {
  const lockKey = sessionLockKey(sessionStore, sessionId);
  if (activeSessionLocks.has(lockKey)) {
    throw new BrunchSkillError("session_locked", "This Brunch session already has a running request.", { status: 409, retryable: true });
  }
  const pending = Promise.resolve().then(operation);
  activeSessionLocks.set(lockKey, pending);
  try {
    return await pending;
  } finally {
    if (activeSessionLocks.get(lockKey) === pending) activeSessionLocks.delete(lockKey);
  }
}

export async function patchBrunchChatPreview({
  sessionId,
  assistantMessageIndex,
  turnId = null,
  versionId = null,
  writing_preview,
  expectedMarkdownHash = null,
  sessionStore = createFileSessionStore()
}) {
  const input = validateTurnInput({ sessionId, message: "preview patch" });
  if ((turnId !== null || versionId !== null) && (typeof turnId !== "string" || !turnId || typeof versionId !== "string" || !versionId)) {
    throw new BrunchSkillError("invalid_request", "turnId and versionId must be supplied together.", { status: 422, fieldErrors: { turnId: "turnId and versionId are required together." } });
  }
  if (turnId === null && (!Number.isInteger(assistantMessageIndex) || assistantMessageIndex < 0)) {
    throw new BrunchSkillError("invalid_request", "assistantMessageIndex must be a non-negative integer.", { status: 422, fieldErrors: { assistantMessageIndex: "assistantMessageIndex must be a non-negative integer." } });
  }
  let normalizedPreview;
  try {
    if (!writing_preview || typeof writing_preview !== "object" || Array.isArray(writing_preview)) throw new Error("writing_preview must be an object");
    const unknownPreviewFields = Object.keys(writing_preview).filter((key) => !["title", "subtitle", "markdown"].includes(key));
    if (unknownPreviewFields.length) throw new Error(`writing_preview contains unknown fields: ${unknownPreviewFields.join(", ")}`);
    normalizedPreview = normalizeWritingPreview(writing_preview);
  } catch (error) {
    throw new BrunchSkillError("invalid_request", error instanceof Error ? error.message : "writing_preview is invalid.", { status: 422, fieldErrors: { writing_preview: error instanceof Error ? error.message : "writing_preview is invalid." } });
  }
  return withBrunchSessionLock({ sessionStore, sessionId: input.sessionId, operation: async () => {
    const session = await sessionStore.read(input.sessionId);
    validateMessages(session.messages);
    if (turnId === null && isSessionV3(session)) {
      const targetReference = sessionV3TargetForMessageIndex(session, assistantMessageIndex);
      if (!targetReference) {
        throw new BrunchSkillError("invalid_request", "assistantMessageIndex must point to an active assistant version.", { status: 422, fieldErrors: { assistantMessageIndex: "assistantMessageIndex must point to an active assistant version." } });
      }
      try {
        const currentVersion = findSessionV3Version(findSessionV3Turn(session, targetReference.turnId), targetReference.versionId);
        const currentMarkdown = currentVersion?.content?.writing_preview?.markdown ?? "";
        if (expectedMarkdownHash && hash(currentMarkdown) !== expectedMarkdownHash) {
          throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being edited.", { status: 409, retryable: true, details: { reason: "preview_conflict", expectedMarkdownHash, currentMarkdownHash: hash(currentMarkdown), turnId: targetReference.turnId, versionId: targetReference.versionId } });
        }
        const currentPreview = normalizeWritingPreview(currentVersion?.content?.writing_preview);
        const nextPreview = expectedMarkdownHash ? { ...currentPreview, markdown: normalizedPreview.markdown } : normalizedPreview;
        const next = replaceSessionV3Preview(session, { ...targetReference, writing_preview: nextPreview });
        await sessionStore.write(input.sessionId, next.messages, sessionV3Metadata(next));
        return { writing_preview: nextPreview };
      } catch (error) {
        if (error instanceof BrunchSkillError) throw error;
        throw new BrunchSkillError("invalid_request", error instanceof Error ? error.message : "The selected writing preview does not exist.", { status: 422, fieldErrors: { assistantMessageIndex: "The selected writing preview does not exist." }, details: { reason: "target_preview_missing", assistantMessageIndex } });
      }
    }
    if (turnId !== null) {
      try {
        const migrated = migrateSessionToV3({ ...session, sessionId: session.sessionId ?? input.sessionId }, { sessionId: input.sessionId });
        const currentVersion = findSessionV3Version(findSessionV3Turn(migrated, turnId), versionId);
        const currentMarkdown = currentVersion?.content?.writing_preview?.markdown ?? "";
        if (expectedMarkdownHash && hash(currentMarkdown) !== expectedMarkdownHash) {
          throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being edited.", { status: 409, retryable: true, details: { reason: "preview_conflict", expectedMarkdownHash, currentMarkdownHash: hash(currentMarkdown), turnId, versionId } });
        }
        const currentPreview = normalizeWritingPreview(currentVersion?.content?.writing_preview);
        const nextPreview = expectedMarkdownHash ? { ...currentPreview, markdown: normalizedPreview.markdown } : normalizedPreview;
        const next = replaceSessionV3Preview(migrated, { turnId, versionId, writing_preview: nextPreview });
        await sessionStore.write(input.sessionId, next.messages, sessionV3Metadata(next));
        return { writing_preview: nextPreview };
      } catch (error) {
        if (error instanceof BrunchSkillError) throw error;
        throw new BrunchSkillError("invalid_request", error instanceof Error ? error.message : "The selected writing preview does not exist.", { status: 422, fieldErrors: { turnId: "The selected writing preview does not exist." }, details: { reason: "target_preview_missing", turnId, versionId } });
      }
    }
    const target = session.messages[assistantMessageIndex];
    if (!target || target.role !== "assistant") {
      throw new BrunchSkillError("invalid_request", "assistantMessageIndex must point to an assistant turn.", { status: 422, fieldErrors: { assistantMessageIndex: "assistantMessageIndex must point to an assistant turn." } });
    }
    if (!target.content?.writing_preview) {
      throw new BrunchSkillError("invalid_request", "The selected assistant turn has no writing preview.", { status: 422, fieldErrors: { assistantMessageIndex: "The selected assistant turn has no writing preview." }, details: { reason: "target_preview_missing", assistantMessageIndex } });
    }
    const currentMarkdown = target.content.writing_preview.markdown;
    if (expectedMarkdownHash && hash(currentMarkdown) !== expectedMarkdownHash) {
      throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being edited.", { status: 409, retryable: true, details: { reason: "preview_conflict", expectedMarkdownHash, currentMarkdownHash: hash(currentMarkdown), assistantMessageIndex } });
    }
    const nextPreview = expectedMarkdownHash
      ? { ...normalizeWritingPreview(target.content.writing_preview), markdown: normalizedPreview.markdown }
      : normalizedPreview;
    const nextMessages = cloneSession(session.messages);
    nextMessages[assistantMessageIndex] = {
      ...nextMessages[assistantMessageIndex],
      content: {
        ...nextMessages[assistantMessageIndex].content,
        writing_preview: nextPreview
      }
    };
    await sessionStore.write(input.sessionId, nextMessages);
    return { writing_preview: nextPreview };
  }});
}

export function buildCodexArgs({ root, rawPath, prompt, outputSchemaPath = null, model = CODEX_PROVIDER_MODEL, reasoningEffort = CODEX_PROVIDER_REASONING_EFFORTS.medium }) {
  return [
    "--search",
    "exec",
    "--model",
    model,
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "--cd",
    root,
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--ignore-user-config",
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    "--output-last-message",
    rawPath,
    prompt
  ];
}

export function runCodex({ root = DEFAULT_ROOT, rawPath, prompt, outputSchema = null, signal, timeoutMs = BRUNCH_SKILL_TIMEOUT_MS, model = CODEX_PROVIDER_MODEL, reasoningEffort = CODEX_PROVIDER_REASONING_EFFORTS.medium, spawnProcess = spawn, terminationGraceMs = 2_000 }) {
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  const outputSchemaPath = outputSchema ? `${rawPath}.schema.json` : null;
  if (outputSchemaPath) fs.writeFileSync(outputSchemaPath, `${JSON.stringify(outputSchema)}\n`, "utf8");
  return new Promise((resolve) => {
    const startedMs = Date.now();
    const child = spawnProcess("codex", buildCodexArgs({ root, rawPath, prompt, outputSchemaPath, model, reasoningEffort }), {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let terminationTimer;
    let terminationResult = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener("abort", cancel);
      resolve({ ...result, model, reasoningEffort, durationMs: Date.now() - startedMs });
    };
    const terminate = () => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); return; } catch { /* Fall through to direct child. */ }
      }
      child.kill("SIGTERM");
    };
    const requestTermination = (result) => {
      if (settled || terminationResult) return;
      terminationResult = result;
      terminate();
      terminationTimer = setTimeout(() => {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Child may have exited after SIGTERM. */ }
        } else {
          try { child.kill("SIGKILL"); } catch { /* Child may have exited after SIGTERM. */ }
        }
        finish({ ...terminationResult, forcedTermination: true });
      }, Math.max(0, terminationGraceMs));
    };
    const cancel = () => {
      requestTermination({ code: 130, cancelled: true, stdout, stderr });
    };
    timer = setTimeout(() => {
      requestTermination({ code: 124, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish(terminationResult ?? { code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => finish(terminationResult ?? { code: code ?? 1, stdout, stderr }));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

function emitLog(onLog, event) {
  if (typeof onLog === "function") onLog(event);
}

function errorForExecution(execution) {
  if (execution?.timedOut) return new BrunchSkillError("timeout", "Brunch Skill generation timed out.", { status: 504, retryable: true });
  if (execution?.cancelled) return new BrunchSkillError("cancelled", "Brunch Skill generation was cancelled.", { status: 499, retryable: true });
  return new BrunchSkillError("codex_failed", "Brunch Skill generation failed.", { status: 502, retryable: true });
}

function rawFromExecution(execution, rawPath) {
  return execution?.raw ?? (fs.existsSync(rawPath) ? fs.readFileSync(rawPath, "utf8") : execution?.stdout ?? "");
}

function invalidStageResponse(stage, parsed) {
  const code = stage === "source_discovery" ? "invalid_source_discovery" : stage === "research" ? "invalid_evidence_bundle" : "invalid_model_response";
  return new BrunchSkillError(code, `Brunch Skill ${stage} 응답을 검증하지 못했습니다: ${parsed.errorMessage}`, { status: 502, retryable: true });
}

function buildTimeoutFallbackResponse({ message, evidenceBundle }) {
  const claims = (evidenceBundle?.claims ?? [])
    .filter((claim) => typeof claim?.statement === "string" && claim.statement.trim())
    .slice(0, 6);
  const directions = (evidenceBundle?.possible_directions ?? [])
    .filter((direction) => typeof direction?.judgment === "string" && direction.judgment.trim());
  const gaps = [
    ...(evidenceBundle?.sufficiency?.blocking_gaps ?? []),
    ...(evidenceBundle?.sufficiency?.missing ?? []),
    ...(evidenceBundle?.evidence_gaps ?? [])
  ].filter((gap) => typeof gap === "string" && gap.trim()).slice(0, 4);
  const sections = [
    "시간이 부족해 지금까지 확인된 근거만 먼저 정리했습니다.",
    evidenceBundle?.topic ? `### 현재 다루는 주제\n${evidenceBundle.topic}` : "",
    evidenceBundle?.core_question ? `### 중심 질문\n${evidenceBundle.core_question}` : "",
    claims.length > 0
      ? `### 확인된 근거\n${claims.map((claim) => `- ${claim.statement}`).join("\n")}`
      : "",
    gaps.length > 0
      ? `### 아직 확인이 필요한 부분\n${gaps.map((gap) => `- ${gap}`).join("\n")}`
      : "",
    `요청하신 내용은 다음 응답에서 이 근거를 바탕으로 이어가겠습니다.\n\n> ${normalizeBrunchText(message).trim()}`
  ].filter(Boolean).join("\n\n");
  const choices = directions.map((direction) => ({
    label: normalizeBrunchText(direction.judgment).trim(),
    description: normalizeBrunchText(direction.risk || "확인된 근거를 바탕으로 이 방향을 발전시킵니다.").trim()
  }));
  return normalizeResponse({
    markdown: sections,
    choices,
    ...(choices.length > 0 ? { question: "지금까지 확인한 근거를 바탕으로 어떤 방향으로 이어갈까요?" } : {})
  });
}

function isTimeoutFailure(error) {
  return error?.code === "timeout" || error?.timedOut === true;
}

function reasoningEffortForStage(stage, requestedReasoningEffort) {
  return requestedReasoningEffort;
}

async function executeStage({ stage, prompt, root, tempDir, signal, timeoutMs, budget = null, executeCodex, executionTransport, onLog, onProgress, onDebug, sessionKey, model, reasoningEffort: requestedReasoningEffort, onGeneration, onGenerationFinished, editorialPhase = null, operation = null, outputSchema: requestedOutputSchema = null, parseOutput = null, finishRequest = null, disableFinishSteer = false }) {
  onDebug ??= onLog?.debugRecorder ? (value) => onLog.debugRecorder.recordCall(value) : null;
  const rawPath = path.join(tempDir, `${stage}.txt`);
  const reasoningEffort = reasoningEffortForStage(stage, requestedReasoningEffort);
  budget?.beginStage?.(stage, budget.stageTimeouts?.[stage]);
  const stageTimeoutMs = budget?.timeoutForStage(stage, timeoutMs) ?? timeoutMs;
  let finishTimer;
  let generation;
  const requestFinish = async () => {
    if (!budget || !generation || !budget.markFinishRequested(stage)) return;
    emitLog(onLog, { type: "stage_finish_requested", stage, sessionKey, model, reasoningEffort, remainingMs: budget.remainingMs() });
    try {
      await generation.steer(finishRequest ?? FINISH_REQUESTS[stage] ?? FINISH_REQUESTS.edit);
    } catch (error) {
      emitLog(onLog, { type: "stage_finish_request_failed", stage, sessionKey, errorCode: error?.code ?? "steer_failed" });
    }
  };
  const scheduleFinish = () => {
    if (!budget || !generation || disableFinishSteer) return;
    // A caller may give a stage a shorter timeout than the whole-turn budget.
    // Keep the automatic finish steer inside both deadlines so it is never
    // scheduled after the transport has already been told to stop.
    const delayMs = Math.min(
      budget.msUntilFinish(stage),
      Math.max(0, stageTimeoutMs - 1)
    );
    finishTimer = setTimeout(() => { void requestFinish(); }, delayMs);
  };
  const publishGeneration = (value) => {
    generation = { ...value, stage };
    onGeneration?.(generation);
    scheduleFinish();
  };
  const finishGeneration = (value) => {
    clearTimeout(finishTimer);
    onGenerationFinished?.({ ...value, stage });
  };
  const outputSchema = requestedOutputSchema ?? (stage === "source_discovery"
    ? buildSourceDiscoveryAppServerOutputSchema()
    : stage === "research"
      ? buildEvidenceAppServerOutputSchema()
      : buildAppServerOutputSchema());
  emitLog(onLog, { type: "stage_started", stage, model, reasoningEffort, promptBytes: Buffer.byteLength(prompt, "utf8") });
  emitProgress(onProgress, {
    editorialPhase,
    operation,
    stage,
    activity: stageActivity(operation, stage),
    startedAt: new Date().toISOString()
  });
  let execution;
  try {
    execution = executionTransport
      ? await executionTransport.executeTurn({
        root,
        prompt,
        outputSchema,
        signal,
        timeoutMs: stageTimeoutMs,
        stage,
        model,
        reasoningEffort,
        ephemeral: true,
        onEvent: onLog,
        onGeneration: publishGeneration,
        onGenerationFinished: finishGeneration
      })
      : await executeCodex({
        root,
        rawPath,
        prompt,
        outputSchema,
        signal,
        timeoutMs: stageTimeoutMs,
        stage,
        model,
        reasoningEffort
      });
  } finally {
    clearTimeout(finishTimer);
  }
  if (!execution || execution.code !== 0) {
    onDebug?.({ stage, prompt, raw: "", parsed: null, execution });
    throw errorForExecution(execution);
  }
  const raw = rawFromExecution(execution, rawPath);
  if (!String(raw).trim()) {
    onDebug?.({ stage, prompt, raw, parsed: null, execution });
    throw new BrunchSkillError("codex_empty_output", `Brunch Skill ${stage} 단계가 빈 응답을 반환했습니다.`, { status: 502, retryable: true });
  }
  const parsed = typeof parseOutput === "function" ? parseOutput(raw) : stage === "source_discovery"
    ? parseSourceDiscoveryResponse(raw)
    : stage === "research"
      ? parseEvidenceComponentResponse(raw, Object.keys(buildEvidenceAppServerOutputSchema().properties), "invalid_evidence_synthesis")
      : parseModelResponse(raw);
  onDebug?.({ stage, prompt, raw, parsed, execution });
  emitLog(onLog, {
    type: "stage_finished",
    stage,
    sessionKey,
    model,
    reasoningEffort,
    exitCode: execution.code,
    durationMs: execution.durationMs ?? 0,
    parseMode: parsed.parseMode,
    promptBytes: Buffer.byteLength(prompt, "utf8")
  });
  emitProgress(onProgress, {
    editorialPhase,
    operation,
    stage,
    activity: "finishing_response",
    durationMs: execution.durationMs ?? 0
  });
  if (!parsed.valid) throw invalidStageResponse(stage, parsed);
  return { execution, parsed, promptBytes: Buffer.byteLength(prompt, "utf8") };
}

function articleStyleReference(root) {
  const stylePath = path.join(root, "skills", "oz-brunch-editorial-chat", "references", "writing-quality.md");
  try {
    return { path: stylePath, content: fs.readFileSync(stylePath, "utf8") };
  } catch {
    return { path: stylePath, content: "" };
  }
}

function curatedPhase(value) {
  return ["topic_discovery", "topic_research", "outline", "article", "open_editing"].includes(value) ? value : null;
}

function curatedInitialTopicRequest(message) {
  return /(?:글감|주제).*(?:찾|추천)/u.test(String(message ?? ""));
}

function curatedRetryRequest(message, interaction) {
  return interaction?.action === "retry_topics" || /모두\s*별로|다시\s*(?:찾|검색|생성)/u.test(String(message ?? ""));
}

function curatedNavigationIntent(message) {
  const text = String(message ?? "").replace(/\s+/gu, " ").trim();
  if (/새\s*주제\s*(?:탐색|검색)\s*시작|처음부터\s*다시\s*(?:찾|검색)/u.test(text)) {
    return { type: "topic_discovery_restart", rejectCurrent: true };
  }
  if (/다시\s*주제\s*선택|이\s*주제\s*말고(?:\s*다른)?\s*(?:걸|것|주제)?\s*(?:보|고르|찾)|다른\s*주제\s*(?:를?\s*)?(?:보|고르|찾)/u.test(text)) {
    return { type: "topic_selection_back", rejectCurrent: /이\s*주제\s*말고|다른\s*주제/u.test(text) };
  }
  return null;
}

function normalizedCuratedSelectionText(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function curatedSelectionIntent(message, candidates) {
  const text = String(message ?? "").replace(/\s+/gu, " ").trim();
  if (!/(?:로\s*(?:가|진행|보|써)|를?\s*(?:보|조사|살펴|선택)|가\s*좋|진행하자)/u.test(text)) return null;
  const normalizedText = normalizedCuratedSelectionText(text);
  const matches = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const aliases = [candidate.label, candidate.seed_title]
      .flatMap((value) => String(value ?? "").split(/[·|/,:：()（）]+/u))
      .map((value) => value.trim())
      .filter((value) => value.length >= 2)
      .map(normalizedCuratedSelectionText)
      .filter(Boolean);
    if (aliases.some((alias) => normalizedText.includes(alias))) matches.push(candidate);
  }
  if (matches.length === 1) return { type: "candidate_selection", candidate: matches[0] };
  if (matches.length > 1) return { type: "candidate_selection_ambiguous", candidates: matches };
  return null;
}

function curatedResearchRequest(message) {
  return /(조사|검색|확인|검증|자료|출처|근거|반응|사례|최근|더\s*찾)/u.test(String(message ?? ""));
}

function curatedOutlineRequest(message) {
  return /(?:목차|구성|outline|아웃라인).*(?:잡|작성|정리|만들)|^(?:먼저\s*)?(?:목차|구성)(?:만)?/iu.test(String(message ?? ""));
}

function curatedArticleRequest(message) {
  const text = String(message ?? "").replace(/\s+/gu, " ").trim();
  const articleObject = /(?:전체\s*(?:원고|초안)|원고|본문|전체\s*글)/u.test(text);
  const articleAction = /(?:작성|써|쓰|만들|생성|옮겨|진행|바로)/u.test(text);
  return articleObject && articleAction;
}

function curatedOpenEditingChangeRequest(message) {
  return /(?:수정|다듬|고쳐|바꿔|다시\s*써|rewrite|humanizer|문장|문단|소제목|접속사|줄여|늘려|삭제|추가)/iu.test(String(message ?? ""));
}

function curatedPlan({ session, message, interaction }) {
  const phaseBefore = curatedPhase(session.editorial_state?.phase);
  const phase = phaseBefore ?? (session.messages.some((entry) => entry?.role === "assistant" && entry.content?.writing_preview) ? "open_editing" : "topic_discovery");
  const navigation = curatedNavigationIntent(message);
  const selection = curatedSelectionIntent(message, session.editorial_state?.topic_candidates);
  if (navigation?.type === "topic_discovery_restart" && ["topic_discovery", "topic_research", "outline"].includes(phase)) {
    return { phaseBefore, phase, phaseAfter: "topic_discovery", operation: "curated_topic_discovery", intent: "topic_discovery_restart", stages: ["source_discovery", "edit"], discovery: true, navigation };
  }
  if (navigation?.type === "topic_selection_back" && ["topic_discovery", "topic_research", "outline"].includes(phase)) {
    return { phaseBefore, phase, phaseAfter: "topic_discovery", operation: "curated_topic_selection", intent: "topic_selection_back", stages: ["edit"], navigation };
  }
  if (phase === "topic_discovery") {
    if (selection?.type === "candidate_selection") {
      return { phaseBefore, phase, phaseAfter: "topic_research", operation: "curated_topic_research", intent: "topic_selection_free_text", stages: ["research", "edit"], research: true, selection };
    }
    if (selection?.type === "candidate_selection_ambiguous") {
      return { phaseBefore, phase, phaseAfter: "topic_discovery", operation: "curated_topic_selection", intent: "topic_selection_ambiguous", stages: ["edit"], selection };
    }
    if (curatedRetryRequest(message, interaction) || curatedInitialTopicRequest(message)) {
      return { phaseBefore, phase, phaseAfter: phase, operation: curatedRetryRequest(message, interaction) ? "curated_topic_discovery" : "curated_topic_discovery", intent: curatedRetryRequest(message, interaction) ? "topic_retry" : "topic_discovery", stages: ["source_discovery", "edit"], discovery: true };
    }
    return { phaseBefore, phase, phaseAfter: "topic_research", operation: "curated_topic_research", intent: "topic_research", stages: ["research", "edit"], research: true };
  }
  if (phase === "topic_research") {
    if (curatedOutlineRequest(message)) return { phaseBefore, phase, phaseAfter: "outline", operation: "outline", intent: "outline_request", stages: ["edit"] };
    if (curatedResearchRequest(message)) return { phaseBefore, phase, phaseAfter: phase, operation: "curated_topic_research", intent: "research", stages: ["research", "edit"], research: true };
    return { phaseBefore, phase, phaseAfter: phase, operation: "curated_conversation", intent: "editorial_conversation", stages: ["edit"] };
  }
  if (phase === "outline") {
    if (curatedArticleRequest(message)) return { phaseBefore, phase, phaseAfter: "open_editing", operation: "article", intent: "article_request", stages: ["edit"] };
    return { phaseBefore, phase, phaseAfter: phase, operation: "outline", intent: "outline_revision", stages: ["edit"] };
  }
  if (phase === "article" || phase === "open_editing") return { phaseBefore, phase, phaseAfter: "open_editing", operation: "open_editing", intent: "open_editing", stages: ["edit"] };
  return { phaseBefore: null, phase: "topic_discovery", phaseAfter: "topic_discovery", operation: "curated_topic_discovery", intent: "topic_discovery", stages: ["source_discovery", "edit"], discovery: true };
}

function curatedSourceStorage(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  try {
    return normalizeSourceDiscoveryBundle({
      query: bundle.query ?? "curated discovery",
      checked_at: bundle.checked_at ?? new Date().toISOString(),
      sources: Array.isArray(bundle.sources) ? bundle.sources.slice(0, 4) : [],
      gaps: Array.isArray(bundle.gaps) ? bundle.gaps : []
    });
  } catch {
    return null;
  }
}

function curatedArchiveMetadata(archive) {
  const context = archiveContextForPrompt(archive);
  return {
    status: context.status,
    fetched_at: context.fetched_at,
    latest_published_at: context.latest_published_at,
    article_count: context.article_count,
    articles: (context.articles ?? []).map((article) => ({
      title: article.title,
      subtitle: article.subtitle,
      published_at: article.published_at,
      url: article.url
    }))
  };
}

function curatedCandidateSeeds(bundle, archiveContext) {
  const seeds = Array.isArray(bundle?.seeds) ? bundle.seeds : [];
  const qualityExclusions = [];
  const qualitySeeds = seeds.filter((seed) => {
    const fit = validateCuratedCandidateFit(seed);
    if (fit.valid) return true;
    qualityExclusions.push({ candidate_id: seed?.candidate_id ?? null, label: seed?.label ?? null, reason: fit.reason });
    return false;
  });
  const uniqueSeeds = qualitySeeds
    .filter((seed) => seed?.archive_relation !== "duplicate")
    .filter((seed, index, all) => all.findIndex((candidate) => {
      if (candidate?.candidate_id && seed?.candidate_id) return candidate.candidate_id === seed.candidate_id;
      return candidate?.label === seed?.label;
    }) === index);
  const deduped = dedupeCuratedSeedsAgainstArchive(uniqueSeeds, archiveContext);
  return { ...deduped, qualityExclusions };
}

export function curatedDiscoveryPasses(message) {
  const text = String(message ?? "");
  const excludesDomestic = /국내\s*(?:말고|외에)|한국\s*(?:말고|외에)/iu.test(text);
  const domesticOnly = !excludesDomestic && /(?:국내\s*(?:만|소스|디자인|글감)|한국\s*(?:만|소스|디자인|글감)|디자인\s*(?:플러스|컴퍼스)|surfit|요즘\s*it|careet|토스\s*디자인|당근\s*디자인|오늘의집\s*디자인)/iu.test(text);
  return domesticOnly ? ["domestic"] : ["domestic", "overseas"];
}

function mergeCuratedDiscoveryBundles(primary, fallback) {
  if (!fallback) return primary;
  const uniqueBy = (entries, key) => [...new Map((entries ?? []).map((entry) => [String(entry?.[key] ?? JSON.stringify(entry)), entry])).values()];
  return {
    ...(primary ?? {}),
    query: [primary?.query, fallback?.query].filter(Boolean).join("\n"),
    checked_at: fallback.checked_at ?? primary?.checked_at,
    sources: uniqueBy([...(primary?.sources ?? []), ...(fallback.sources ?? [])], "url"),
    gaps: [...new Set([...(primary?.gaps ?? []), ...(fallback.gaps ?? [])])],
    seeds: uniqueBy([...(primary?.seeds ?? []), ...(fallback.seeds ?? [])], "label"),
    source_checks: uniqueBy([...(primary?.source_checks ?? []), ...(fallback.source_checks ?? [])], "source_id"),
    article_opens: uniqueBy([...(primary?.article_opens ?? []), ...(fallback.article_opens ?? [])], "url"),
    archive_duplicate_exclusions: [...(primary?.archive_duplicate_exclusions ?? []), ...(fallback.archive_duplicate_exclusions ?? [])],
    finish_reason: fallback.finish_reason ?? primary?.finish_reason ?? "source_pool_completed"
  };
}

function runtimeSourceEvidence(bundle, events) {
  const canonical = (value) => {
    try {
      const url = new URL(String(value ?? ""));
      url.hash = "";
      url.search = "";
      return url.toString().replace(/\/$/u, "").toLowerCase();
    } catch {
      return String(value ?? "").split("#")[0].split("?")[0].replace(/\/$/u, "").toLowerCase();
    }
  };
  const searchEvents = Array.isArray(events) ? events.filter((event) => event?.type === "app_server_search_event") : [];
  const observed = searchEvents.length > 0;
  const openedUrls = searchEvents.flatMap((event) => Array.isArray(event.openedUrls) ? event.openedUrls : []).filter((url) => typeof url === "string");
  const openedSet = new Set(openedUrls.map(canonical));
  return {
    searchEventCount: observed ? searchEvents.length : "unknown",
    sources: (Array.isArray(bundle?.sources) ? bundle.sources : []).map((source) => {
      const url = typeof source?.url === "string" ? source.url : null;
      const canonicalUrl = url ? canonical(url) : null;
      return {
        url,
        searchObserved: observed,
        openedObserved: observed ? (openedUrls.length > 0 ? openedSet.has(canonicalUrl) : "unknown") : "unknown"
      };
    }),
    note: "source_checks and article_opens are model-reported; runtime values come only from observed App Server search events."
  };
}

function guardCuratedResponse(response, { operation, allowWritingPreview = operation === "article", sessionKey, onLog }) {
  if (!response || allowWritingPreview || !response.writing_preview) return { response, violation: null };
  const violation = {
    type: "curated_contract_violation",
    sessionKey,
    operation,
    violation: "writing_preview_not_allowed"
  };
  emitLog(onLog, violation);
  const { writing_preview: _ignoredWritingPreview, ...safeResponse } = response;
  return { response: safeResponse, violation };
}

function curatedSeedForSelection(session, interaction, message, plan) {
  const candidates = Array.isArray(session.editorial_state?.topic_candidates) ? session.editorial_state.topic_candidates : [];
  const label = interaction?.type === "choice" && interaction.choiceLabel
    ? interaction.choiceLabel
    : plan.research ? String(message ?? "").trim() : null;
  if (!label || label === "모두 별로예요. 다시 찾아주세요") return null;
  const selected = candidates.find((candidate) => (typeof candidate === "string" ? candidate : candidate?.label) === label);
  if (selected && typeof selected === "object") return cloneValue(selected);
  return {
    candidate_id: null,
    label,
    seed_publication: "사용자 입력",
    seed_title: label,
    seed_url: "",
    published_at: null,
    event: label,
    why_interesting: "사용자가 직접 선택하거나 제시한 주제입니다.",
    archive_relation: "unknown"
  };
}

async function runCuratedBrunchTurn({
  root,
  input,
  session,
  sessionStore,
  signal,
  timeoutMs,
  executeCodex,
  onLog,
  executionTransport,
  model,
  reasoningEffort,
  modelPreset,
  extraUserMessages,
  interaction,
  onProgress,
  onGeneration,
  onGenerationFinished,
  pipeline,
  fetchArchive = fetchBrunchLiveArchive
}) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const plan = curatedPlan({ session, message: input.message, interaction });
  const sessionKey = safeSessionId(input.sessionId);
  const turnModel = model;
  const turnReasoningEffort = reasoningEffort;
  const effectiveTimeoutMs = timeoutMs === BRUNCH_SKILL_TIMEOUT_MS || timeoutMs === 600_000
    ? timeoutForBrunchOperation(plan.operation, timeoutMs)
    : timeoutMs;
  const curatedStageTimeouts = stageTimeoutsForBrunchOperation(plan.operation);
  const turnBudget = createBrunchTurnBudget({
    timeoutMs: effectiveTimeoutMs,
    stageTimeouts: curatedStageTimeouts,
    stageFinishGraceMs: Object.fromEntries(plan.stages.map((stage) => [stage, plan.operation === "curated_topic_discovery" && stage === "source_discovery" ? 10_000 : 8_000]))
  });
  turnBudget.stageTimeouts = curatedStageTimeouts;
  let debugRecorder = null;
  let debugStatus = "failed";
  let debugMetadata = null;
  let debugError = null;
  let observedOnLog = onLog ?? (() => {});
  if (isDebugTraceEnabled()) {
    debugRecorder = createDebugTurnRecorder({
      root,
      sessionId: input.sessionId,
      manifest: {
        sessionId: input.sessionId,
        runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
        userInput: input.message,
        interactionType: interaction?.type ?? "free_text",
        choiceLabel: interaction?.type === "choice" ? interaction.choiceLabel ?? input.message : null,
        phaseBefore: plan.phaseBefore,
        intent: plan.intent,
        operation: plan.operation,
        plannedStages: plan.stages,
        modelPreset: modelPreset ?? null,
        model: turnModel,
        reasoningEffort: turnReasoningEffort
      }
    });
    debugRecorder.recordStateBefore(session.editorial_state ?? null, session.evidence_bundle ?? null, null);
    const baseOnLog = onLog;
    observedOnLog = (event) => {
      emitLog(baseOnLog, event);
      debugRecorder.recordLog(event);
    };
    observedOnLog.debugRecorder = debugRecorder;
  }
  emitLog(observedOnLog, {
    type: "turn_started",
    sessionKey,
    runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
    model: turnModel,
    reasoningEffort: turnReasoningEffort,
    messageCount: session.messages.length,
    startedAt,
    ...(plan.phaseBefore ? { editorialPhase: plan.phaseBefore } : {}),
    operation: plan.operation
  });
  emitProgress(onProgress, { editorialPhase: plan.phase, operation: plan.operation, activity: "request_received", startedAt });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oz-brunch-curated-"));
  let pipelineContext = null;
  let stageTransport = executionTransport;
  let keepPipelineContext = false;
  let lastPublishedGeneration = null;
  let totalPromptBytes = 0;
  let totalDurationMs = 0;
  let finalResponse = null;
  let finalParseMode = null;
  let sourceDiscovery = session.title_research_sources ?? null;
  let selectedTopic = session.editorial_state?.selected_topic ?? null;
  let selectedSeed = session.editorial_state?.selected_topic_seed ?? null;
  let researchBundle = session.editorial_state?.curated_research ?? null;
  let outlineMarkdown = session.editorial_state?.outline_markdown ?? session.editorial_state?.outline ?? null;
  let nextEditorialState = { ...(session.editorial_state ?? {}), phase: plan.phaseAfter, last_user_delta: input.message };
  let turnTimedOut = false;
  let contractViolation = null;
  const interactionState = interaction?.type
    ? { last_interaction_type: interaction.type, ...(interaction.type === "choice" && interaction.choiceLabel ? { last_choice_label: interaction.choiceLabel } : {}) }
    : {};
  nextEditorialState = { ...nextEditorialState, ...interactionState };
  const stageOnGeneration = (generation) => {
    lastPublishedGeneration = generation;
    onGeneration?.(generation);
  };
  const stageOnGenerationFinished = () => {};
  let discoveryDiagnostics = null;
  const stageEventsByStage = new Map();

  try {
    if (pipeline && executionTransport && typeof executionTransport.beginPipeline === "function") {
      const staleNavigationContext = plan.navigation && curatedPipelineContexts.get(sessionKey)?.context;
      if (staleNavigationContext) {
        await releaseCuratedPipelineContext(input.sessionId, staleNavigationContext);
        emitLog(observedOnLog, { type: "pipeline_context_reset", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, reason: plan.intent });
      }
      const acquired = await acquireCuratedPipelineContext({ sessionId: input.sessionId, executionTransport, model: turnModel, root, cwd: tempDir });
      pipelineContext = acquired.context;
      keepPipelineContext = true;
      stageTransport = pipelineContext;
      emitLog(observedOnLog, { type: acquired.reused ? "pipeline_context_reused" : "pipeline_context_started", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, threadId: pipelineContext.threadId });
    }
    const promptHistory = pipelineContext && curatedPipelineContexts.get(sessionKey)?.context === pipelineContext && curatedPipelineContexts.get(sessionKey)?.lastUsedAt !== undefined && session.messages.length > 0
      ? []
      : session.messages;
    const execute = async (stage, prompt, options = {}) => {
      const stageEvents = [];
      const stageOnLog = (event) => {
        stageEvents.push(event);
        observedOnLog(event);
      };
      if (observedOnLog?.debugRecorder) stageOnLog.debugRecorder = observedOnLog.debugRecorder;
      const existingStageEvents = stageEventsByStage.get(stage);
      if (existingStageEvents) {
        stageEvents.push(...existingStageEvents);
      }
      stageEventsByStage.set(stage, stageEvents);
      const result = await executeStage({
        stage,
        prompt,
        root,
        tempDir,
        signal,
        timeoutMs: effectiveTimeoutMs,
        budget: turnBudget,
        executeCodex,
        executionTransport: stageTransport,
        onLog: stageOnLog,
        onProgress,
        sessionKey,
        model: turnModel,
        reasoningEffort: turnReasoningEffort,
        onGeneration: stageOnGeneration,
        onGenerationFinished: stageOnGenerationFinished,
        editorialPhase: plan.phase,
        operation: plan.operation,
        ...options
      });
      totalPromptBytes += result.promptBytes;
      totalDurationMs += result.execution.durationMs ?? 0;
      return result;
    };

    const liveArchive = !(plan.discovery || plan.research) ? null : await (async () => {
      try {
        const archive = await fetchArchive({ signal });
        emitLog(observedOnLog, { type: "brunch_archive_loaded", sessionKey, articleCount: archive.article_count, latestPublishedAt: archive.latest_published_at, fetchedAt: archive.fetched_at, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE });
        return archive;
      } catch (error) {
        if (signal?.aborted) throw error;
        emitLog(observedOnLog, { type: "brunch_archive_unavailable", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, reason: error instanceof Error ? error.message : String(error) });
        return null;
      }
    })();

    if (plan.discovery) {
      const previousTopics = (session.editorial_state?.topic_candidates ?? []).map((candidate) => typeof candidate === "string" ? candidate : candidate?.label).filter(Boolean);
      const discoveryPasses = curatedDiscoveryPasses(input.message);
      const discoveryLanePools = discoveryPasses.map((lane) => ({ lane, sourcePool: curatedDiscoverySourcePoolForLane(lane) }));
      let discovery = null;
      const discoveryExecutions = [];
      const runDiscoveryLane = async ({ lane, sourcePool }) => {
        emitLog(observedOnLog, { type: "curated_discovery_lane_started", sessionKey, lane, sourceCount: sourcePool.length });
        try {
          const result = await execute("source_discovery", buildCuratedDiscoveryPrompt({ userMessage: input.message, archiveContext: curatedArchiveMetadata(liveArchive), rejectedTopics: previousTopics, sourcePool }), {
            outputSchema: buildCuratedDiscoveryAppServerOutputSchema(),
            parseOutput: parseCuratedDiscoveryResponse,
            finishRequest: "추가 source listing 검색을 중단하고 지금까지 확인한 seed와 source audit를 JSON으로 완성하세요. 후보 수를 채우지 마세요."
          });
          discoveryExecutions.push({ lane, result });
          emitLog(observedOnLog, { type: "curated_discovery_lane_completed", sessionKey, lane, durationMs: result.execution?.durationMs ?? null });
          return result;
        } catch (error) {
          if (!isTimeoutFailure(error)) throw error;
          turnTimedOut = true;
          // A timed-out App Server turn may be interrupted with an incomplete
          // conversation. Do not carry that thread into a retry.
          keepPipelineContext = false;
          emitLog(observedOnLog, { type: "curated_discovery_timeout_fallback", sessionKey, lane, reason: "source_discovery_time_budget" });
          return null;
        }
      };

      discovery = await runDiscoveryLane(discoveryLanePools[0]);
      sourceDiscovery = discovery?.parsed?.bundle ?? sourceDiscovery;
      if (sourceDiscovery?.finish_reason === "time_budget") {
        turnTimedOut = true;
        keepPipelineContext = false;
      }
      const firstSeedResult = curatedCandidateSeeds(sourceDiscovery, liveArchive);
      if (discovery && !turnTimedOut && discoveryPasses.length > 1 && firstSeedResult.seeds.length < 2 && turnBudget.remainingMs() > 5_000) {
        emitLog(observedOnLog, {
          type: "curated_discovery_lane_fallback",
          sessionKey,
          from: discoveryPasses[0],
          to: discoveryPasses[1],
          reason: "fewer_than_two_valid_candidates"
        });
        const fallback = await runDiscoveryLane(discoveryLanePools[1]);
        if (fallback?.parsed?.bundle) {
          sourceDiscovery = mergeCuratedDiscoveryBundles(sourceDiscovery, fallback.parsed.bundle);
        }
      }
      const seedResult = curatedCandidateSeeds(sourceDiscovery, liveArchive);
      const seeds = seedResult.seeds;
      discoveryDiagnostics = {
        sourceChecks: sourceDiscovery?.source_checks ?? [],
        sourceChecksTotal: sourceDiscovery?.source_checks?.length ?? 0,
        sourceChecksAttempted: sourceDiscovery?.source_checks?.filter((check) => check.attempted).length ?? 0,
        skippedSources: sourceDiscovery?.source_checks?.filter((check) => !check.attempted) ?? [],
        articleOpens: sourceDiscovery?.article_opens ?? [],
        articleOpenCount: sourceDiscovery?.article_opens?.length ?? 0,
        elapsedMs: discoveryExecutions.length > 0
          ? discoveryExecutions.reduce((total, entry) => total + (entry.result?.execution?.durationMs ?? 0), 0)
          : null,
        lanes: discoveryExecutions.map((entry) => ({ lane: entry.lane, durationMs: entry.result?.execution?.durationMs ?? null })),
        finishReason: turnTimedOut ? "time_budget" : sourceDiscovery?.finish_reason ?? "source_pool_completed",
        seeds,
        seedCandidateCount: seeds.length,
        archiveDuplicateExclusions: (sourceDiscovery?.archive_duplicate_exclusions?.length ?? 0) + seedResult.exclusions.length,
        archiveDuplicateExclusionDetails: [...(sourceDiscovery?.archive_duplicate_exclusions ?? []), ...seedResult.exclusions],
        candidateQualityExclusions: seedResult.qualityExclusions,
        modelReported: {
          sourceChecks: sourceDiscovery?.source_checks ?? [],
          articleOpens: sourceDiscovery?.article_opens ?? []
        },
        runtimeEvidence: runtimeSourceEvidence(sourceDiscovery, stageEventsByStage.get("source_discovery") ?? [])
      };
      debugRecorder?.recordDiscoveryDiagnostics(discoveryDiagnostics);
      emitLog(observedOnLog, {
        type: "curated_source_verification",
        sessionKey,
        modelReported: discoveryDiagnostics.modelReported,
        runtimeEvidence: discoveryDiagnostics.runtimeEvidence
      });
      if (discovery && !turnTimedOut && turnBudget.remainingMs() > 5_000) {
        const edit = await execute("edit", buildCuratedDiscoveryEditPrompt({ history: promptHistory, userMessage: input.message, discoveryBundle: { ...sourceDiscovery, seeds }, archiveContext: curatedArchiveMetadata(liveArchive) }), { outputSchema: buildCuratedEditAppServerOutputSchema(), parseOutput: parseCuratedEditResponse });
        const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
        contractViolation = guarded.violation;
        finalResponse = normalizeCuratedDiscoveryResponse(guarded.response, seeds);
        finalParseMode = edit.parsed.parseMode;
      } else {
        emitLog(observedOnLog, { type: "stage_skipped", stage: "edit", sessionKey, reason: "discovery_time_budget" });
        finalResponse = normalizeCuratedDiscoveryResponse({
          markdown: turnTimedOut
            ? "이번 탐색은 시간 예산이 끝나 지금까지 확인한 결과만 남겼습니다. 아직 후보를 판단할 만큼 탐색이 끝나지 않았습니다."
            : seeds.length
              ? "이번 탐색에서 확인한 후보를 정리했습니다."
              : "이번 탐색에서는 최근 7일 안에 강한 후보를 찾지 못했습니다.",
          question: seeds.length ? "어떤 글감으로 이어갈까요?" : "다시 찾아볼까요?",
          choices: []
        }, seeds);
        finalParseMode = "deterministic_curated_discovery";
      }
      const storedSource = curatedSourceStorage(sourceDiscovery);
      sourceDiscovery = storedSource ?? sourceDiscovery;
      nextEditorialState = {
        phase: "topic_discovery",
        ...interactionState,
        topic_candidates: seeds,
        rejected_topics: [
          ...(session.editorial_state?.rejected_topics ?? []),
          ...(plan.intent === "topic_retry" || plan.intent === "topic_discovery_restart" ? previousTopics : [])
        ].filter((topic, index, all) => all.indexOf(topic) === index),
        selected_topic: null,
        selected_topic_seed: null,
        curated_research: null,
        outline: null,
        outline_markdown: null,
        outline_ready: false,
        article_ready: false,
        last_user_delta: input.message
      };
    } else if (plan.operation === "curated_topic_selection") {
      const seeds = (Array.isArray(session.editorial_state?.topic_candidates) ? session.editorial_state.topic_candidates : [])
        .filter((seed) => seed && typeof seed === "object");
      const edit = await execute("edit", buildCuratedDiscoveryEditPrompt({
        history: promptHistory,
        userMessage: input.message,
        discoveryBundle: { seeds },
        archiveContext: { status: "stored", articles: [] }
      }), { outputSchema: buildCuratedEditAppServerOutputSchema(), parseOutput: parseCuratedEditResponse });
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      finalResponse = normalizeCuratedDiscoveryResponse(guarded.response, seeds);
      finalParseMode = edit.parsed.parseMode;
      const rejectedTopic = plan.navigation?.rejectCurrent ? session.editorial_state?.selected_topic : null;
      nextEditorialState = {
        ...session.editorial_state,
        phase: "topic_discovery",
        ...interactionState,
        selected_topic: null,
        selected_topic_seed: null,
        curated_research: null,
        outline: null,
        outline_markdown: null,
        outline_ready: false,
        article_ready: false,
        ...(rejectedTopic ? { rejected_topics: [...(session.editorial_state?.rejected_topics ?? []), rejectedTopic].filter((topic, index, all) => all.indexOf(topic) === index) } : {}),
        last_user_delta: input.message
      };
    } else if (plan.research) {
      selectedSeed = plan.selection?.candidate
        ? cloneValue(plan.selection.candidate)
        : curatedSeedForSelection(session, interaction, input.message, plan);
      selectedTopic = selectedSeed?.label ?? interaction?.choiceLabel ?? input.message.trim();
      if (plan.stages.includes("source_discovery")) {
        const source = await execute("source_discovery", buildCuratedResearchSourcePrompt({ history: promptHistory, userMessage: input.message, seed: selectedSeed, previousSources: sourceDiscovery, archiveContext: archiveContextForPrompt(liveArchive) }));
        sourceDiscovery = source.parsed.bundle;
      }
      const research = await execute("research", buildCuratedResearchPrompt({ history: promptHistory, userMessage: input.message, seed: selectedSeed, sourceDiscovery, previousResearch: session.editorial_state?.curated_research ?? null }), {
        outputSchema: buildCuratedResearchAppServerOutputSchema(),
        parseOutput: parseCuratedResearchResponse,
        finishRequest: "현재 확인한 원문만 사용해 조사 메모를 완성하세요. 중심 질문이나 방향을 새로 만들지 말고 확인하지 못한 내용은 unknowns로 남기세요."
      });
      researchBundle = research.parsed.bundle;
      const edit = await execute("edit", buildCuratedResearchResponsePrompt({ history: promptHistory, userMessage: input.message, seed: selectedSeed, researchBundle }), { outputSchema: buildCuratedEditAppServerOutputSchema(), parseOutput: parseCuratedEditResponse });
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      finalResponse = normalizeCuratedConversationResponse(guarded.response, { nextAction: edit.parsed.nextAction === "outline" ? "outline" : "none" });
      finalParseMode = edit.parsed.parseMode;
      nextEditorialState = {
        ...session.editorial_state,
        phase: "topic_research",
        ...interactionState,
        topic_candidates: session.editorial_state?.topic_candidates ?? [],
        selected_topic: selectedTopic,
        selected_topic_seed: selectedSeed,
        curated_research: researchBundle,
        outline_ready: false,
        article_ready: false,
        last_user_delta: input.message
      };
    } else if (plan.operation === "curated_conversation") {
      const edit = await execute("edit", buildCuratedResearchResponsePrompt({ history: promptHistory, userMessage: input.message, seed: selectedSeed, researchBundle }), { outputSchema: buildCuratedEditAppServerOutputSchema(), parseOutput: parseCuratedEditResponse });
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      finalResponse = normalizeCuratedConversationResponse(guarded.response, { nextAction: edit.parsed.nextAction === "outline" ? "outline" : "none" });
      finalParseMode = edit.parsed.parseMode;
      nextEditorialState = { ...session.editorial_state, ...interactionState, phase: "topic_research", last_user_delta: input.message };
    } else if (plan.operation === "outline") {
      const outlinePrompt = `${buildOutlinePrompt({ history: promptHistory, userMessage: input.message, selectedTopic, sourceDiscovery: researchBundle ?? sourceDiscovery })}\nCurated action contract: next_action은 article 또는 none 중 하나를 반환하세요. 목차가 완성되어 사용자의 원고 작성 승인을 묻는 경우에만 article을 사용하세요.`;
      const edit = await execute("edit", outlinePrompt, { outputSchema: buildCuratedEditAppServerOutputSchema(), parseOutput: parseCuratedEditResponse });
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      finalResponse = normalizeCuratedOutlineResponse(guarded.response, { nextAction: edit.parsed.nextAction === "article" ? "article" : "none" });
      finalParseMode = edit.parsed.parseMode;
      outlineMarkdown = finalResponse.markdown;
      nextEditorialState = { ...session.editorial_state, ...interactionState, phase: "outline", selected_topic: selectedTopic, outline: outlineMarkdown, outline_markdown: outlineMarkdown, outline_ready: true, article_ready: false, last_user_delta: input.message };
    } else if (plan.operation === "article") {
      const style = articleStyleReference(root);
      if (style.content) emitLog(observedOnLog, { type: "reference_loaded", path: style.path, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, role: "article_style" });
      const edit = await execute("edit", buildArticlePrompt({ history: promptHistory, userMessage: input.message, selectedTopic, sourceDiscovery: researchBundle ?? sourceDiscovery, outlineMarkdown, articleStyle: style.content }));
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      finalResponse = guarded.response;
      finalParseMode = edit.parsed.parseMode;
      nextEditorialState = { ...session.editorial_state, ...interactionState, phase: "open_editing", selected_topic: selectedTopic, outline_markdown: outlineMarkdown, article_ready: Boolean(finalResponse.writing_preview), last_user_delta: input.message };
    } else {
      const style = articleStyleReference(root);
      if (style.content) emitLog(observedOnLog, { type: "reference_loaded", path: style.path, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, role: "article_style" });
      const currentPreview = [...(Array.isArray(session.messages) ? session.messages : [])].reverse().find((entry) => entry?.role === "assistant" && entry.content?.writing_preview)?.content?.writing_preview ?? null;
      const edit = await execute("edit", buildOpenEditingPrompt({ history: promptHistory, userMessage: input.message, selectedTopic, sourceDiscovery: researchBundle ?? sourceDiscovery, currentPreview, articleStyle: style.content }));
      const guarded = guardCuratedResponse(edit.parsed.response, { operation: plan.operation, allowWritingPreview: Boolean(currentPreview), sessionKey, onLog: observedOnLog });
      contractViolation = guarded.violation;
      if (currentPreview && curatedOpenEditingChangeRequest(input.message) && !guarded.response?.writing_preview) {
        const violation = {
          type: "curated_contract_violation",
          sessionKey,
          operation: plan.operation,
          violation: "writing_preview_required_for_edit"
        };
        emitLog(observedOnLog, violation);
        throw new BrunchSkillError("invalid_model_response", "원고를 수정한 응답에는 저장 가능한 전체 writing_preview가 필요합니다.", { status: 502, retryable: true, details: { reason: "writing_preview_required_for_edit" } });
      }
      finalResponse = guarded.response;
      finalParseMode = edit.parsed.parseMode;
      nextEditorialState = {
        ...session.editorial_state,
        ...interactionState,
        phase: "open_editing",
        selected_topic: selectedTopic,
        outline_markdown: outlineMarkdown,
        article_ready: Boolean(finalResponse?.writing_preview ?? session.editorial_state?.article_ready),
        last_user_delta: input.message
      };
    }

    const persistedSteerMessages = extraUserMessages.map((content) => normalizeBrunchText(content));
    let nextMessages;
    let versionMetadata = {};
    if (pipeline) {
      const versioned = appendSessionV3Turn({ ...session, sessionId: session.sessionId ?? input.sessionId }, {
        userMessages: [input.message, ...persistedSteerMessages],
        response: finalResponse,
        model: turnModel,
        reasoningEffort: turnReasoningEffort,
        modelPreset,
        editorialPhaseBefore: plan.phaseBefore,
        editorialPhaseAfter: nextEditorialState.phase,
        curatedStateSnapshot: {
          editorial_state: nextEditorialState,
          ...(sourceDiscovery ? { title_research_sources: curatedSourceStorage(sourceDiscovery) ?? sourceDiscovery } : {})
        }
      });
      nextMessages = versioned.messages;
      const versionedTurn = versioned.turns.at(-1);
      versionMetadata = {
        turnId: versionedTurn?.turnId,
        versionId: versionedTurn?.activeVersionId,
        branchId: versioned.activeBranchId,
        restoreAvailable: Boolean(versionedTurn?.assistantVersions?.at(-1)?.curatedStateSnapshot?.editorial_state),
        versionSummaries: versionedTurn?.assistantVersions?.map((version, index) => ({
          versionId: version.versionId,
          index,
          active: version.versionId === versionedTurn.activeVersionId,
          ...(typeof version.model === "string" ? { model: version.model } : {}),
          ...(typeof version.reasoningEffort === "string" ? { reasoningEffort: version.reasoningEffort } : {}),
          restoreAvailable: Boolean(version.curatedStateSnapshot?.editorial_state)
        })) ?? []
      };
      await sessionStore.write(input.sessionId, nextMessages, {
        ...sessionV3Metadata(versioned),
        runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
        ...(sourceDiscovery ? { title_research_sources: curatedSourceStorage(sourceDiscovery) ?? sourceDiscovery } : {}),
        editorial_state: nextEditorialState
      });
    } else {
      nextMessages = [...session.messages, { role: "user", content: input.message }, ...persistedSteerMessages.map((content) => ({ role: "user", content })), { role: "assistant", content: finalResponse }];
      await sessionStore.write(input.sessionId, nextMessages, { runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, ...(sourceDiscovery ? { title_research_sources: curatedSourceStorage(sourceDiscovery) ?? sourceDiscovery } : {}), editorial_state: nextEditorialState });
    }
    const metadata = {
      model: turnModel,
      reasoningEffort: turnReasoningEffort,
      modelPreset,
      runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE,
      pipeline,
      artifactKind: plan.discovery ? "topic_candidates" : plan.operation === "outline" ? "outline" : plan.operation === "article" ? "full_draft" : "editorial_response",
      durationMs: Date.now() - startedMs,
      stageDurationMs: totalDurationMs,
      budget: turnBudget.snapshot(),
      messageCount: nextMessages.length,
      parseMode: finalParseMode,
      promptBytes: totalPromptBytes,
      exitCode: 0,
      timedOut: turnTimedOut,
      ...(contractViolation ? { contractViolation: contractViolation.violation } : {}),
      cancelled: false,
      sessionKey,
      startedAt,
      editorialPhase: plan.phase,
      editorialPhaseAfter: nextEditorialState.phase,
      operation: plan.operation,
      ...versionMetadata
    };
    debugStatus = "completed";
    debugMetadata = metadata;
    debugRecorder?.recordStateAfter(nextEditorialState, null, null, "turn_completed");
    emitLog(observedOnLog, { type: "turn_finished", ...metadata });
    return { response: finalResponse, metadata };
  } catch (error) {
    keepPipelineContext = false;
    debugError = { code: error?.code ?? "brunch_chat_failed", message: error?.message ?? String(error) };
    debugStatus = error?.code === "cancelled" ? "aborted" : "failed";
    debugRecorder?.recordError(error, { phase: plan.phase, operation: plan.operation });
    emitLog(observedOnLog, { type: "turn_finished", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, model: turnModel, reasoningEffort: turnReasoningEffort, messageCount: session.messages.length, durationMs: Date.now() - startedMs, promptBytes: totalPromptBytes, timedOut: error?.code === "timeout", cancelled: error?.code === "cancelled", errorCode: error?.code ?? "brunch_chat_failed" });
    throw error;
  } finally {
    if (pipelineContext && !keepPipelineContext) {
      try {
        await releaseCuratedPipelineContext(input.sessionId, pipelineContext);
        emitLog(observedOnLog, { type: "pipeline_context_finished", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE });
      } catch (error) {
        emitLog(observedOnLog, { type: "pipeline_context_cleanup_failed", sessionKey, runtimeProfile: CURATED_DISCOVERY_RUNTIME_PROFILE, errorCode: error?.code ?? "cleanup_failed" });
      }
    }
    if (lastPublishedGeneration) onGenerationFinished?.(lastPublishedGeneration);
    debugRecorder?.finalize({ status: debugStatus, turnId: debugMetadata?.turnId ?? null, phaseAfter: debugMetadata?.editorialPhaseAfter ?? nextEditorialState?.phase ?? plan.phase, metadata: debugMetadata, response: finalResponse, error: debugError });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runBrunchSkillTurn({
  root = DEFAULT_ROOT,
  sessionId,
  message,
  sessionStore = createFileSessionStore({ root }),
  signal,
  timeoutMs = BRUNCH_SKILL_TIMEOUT_MS,
  executeCodex = runCodex,
  onLog,
  executionTransport = null,
  model = CODEX_PROVIDER_MODEL,
  reasoningEffort = CODEX_PROVIDER_REASONING_EFFORTS.medium,
  modelPreset = null,
  extraUserMessages = [],
  interaction = null,
  onProgress,
  onGeneration,
  onGenerationFinished,
  fetchArchive = fetchBrunchLiveArchive,
  pipeline = executionTransport ? executionTransport.supportsPipeline === true : executeCodex === runCodex
}) {
  const input = validateTurnInput({ sessionId, message });
  if (!Array.isArray(extraUserMessages) || extraUserMessages.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new BrunchSkillError("invalid_request", "extraUserMessages must contain non-empty strings.", { status: 422, retryable: false });
  }
  return withBrunchSessionLock({ sessionStore, sessionId: input.sessionId, operation: async () => {
    const session = await sessionStore.read(input.sessionId);
    validateMessages(session.messages);
    const validatedInteraction = validateBrunchInteraction(interaction, session, input.message);
    return runCuratedBrunchTurn({ root, input, session, sessionStore, signal, timeoutMs, executeCodex, onLog, executionTransport, model, reasoningEffort, modelPreset, extraUserMessages, interaction: validatedInteraction, onProgress, onGeneration, onGenerationFinished, pipeline, fetchArchive });
  }});
}
