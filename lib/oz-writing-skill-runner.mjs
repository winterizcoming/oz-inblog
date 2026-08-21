import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BrunchSkillError,
  createFileSessionStore,
  normalizeWritingPreview,
  withBrunchSessionLock
} from "./oz-inblog-runner.mjs";
import {
  findSessionV3Turn,
  findSessionV3Version,
  migrateSessionToV3,
  sessionV3TargetForMessageIndex
} from "./oz-brunch-session-v3.mjs";
import { loadWritingSkillBundle, WritingSkillError } from "./oz-writing-skill-registry.mjs";

export const WRITING_SKILL_TIMEOUT_MS = 180_000;
export const WRITING_SKILL_DEFAULT_MODEL_PRESET = "luna-medium";

function loadBrunchResponseStyle(root) {
  const filePath = path.join(root ?? process.cwd(), "skills", "oz-brunch-editorial-chat", "references", "response-style.md");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function buildWritingSkillOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { markdown: { type: "string" } },
    required: ["markdown"]
  };
}

export function hashWritingMarkdown(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrunchSkillError("invalid_request", `${field} is required.`, { status: 422, fieldErrors: { [field]: `${field} is required.` } });
  }
  return value.trim();
}

function nonEmptyText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrunchSkillError("invalid_request", `${field} is required.`, { status: 422, fieldErrors: { [field]: `${field} is required.` } });
  }
  return value;
}

function normalizeHash(value, field) {
  const normalized = nonEmptyString(value, field);
  if (!/^[a-f0-9]{64}$/iu.test(normalized)) {
    throw new BrunchSkillError("invalid_request", `${field} must be a SHA-256 hash.`, { status: 422, fieldErrors: { [field]: `${field} must be a SHA-256 hash.` } });
  }
  return normalized.toLowerCase();
}

export function validateWritingRefineInput(input) {
  const allowedKeys = new Set(["sessionId", "turnId", "versionId", "assistantMessageIndex", "skillId", "markdown", "baseHash", "modelPreset", "instruction"]);
  const unknownKeys = Object.keys(input ?? {}).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new BrunchSkillError("invalid_request", `Unknown fields: ${unknownKeys.join(", ")}`, { status: 422, fieldErrors: { unknown: `Unknown fields: ${unknownKeys.join(", ")}` } });
  }
  const sessionId = nonEmptyString(input?.sessionId, "sessionId");
  if (sessionId.length > 256) throw new BrunchSkillError("invalid_request", "sessionId must be 256 characters or fewer.", { status: 422, fieldErrors: { sessionId: "sessionId must be 256 characters or fewer." } });
  const turnId = typeof input?.turnId === "string" && input.turnId.trim() ? input.turnId.trim() : "";
  const versionId = typeof input?.versionId === "string" && input.versionId.trim() ? input.versionId.trim() : "";
  const assistantMessageIndex = input?.assistantMessageIndex === undefined ? null : input.assistantMessageIndex;
  if ((!turnId || !versionId) && (!Number.isInteger(assistantMessageIndex) || assistantMessageIndex < 0)) {
    throw new BrunchSkillError("invalid_request", "turnId and versionId, or assistantMessageIndex, are required.", { status: 422, fieldErrors: { turnId: "A version target is required.", versionId: "A version target is required." } });
  }
  const skillId = nonEmptyString(input?.skillId, "skillId");
  const markdown = nonEmptyText(input?.markdown, "markdown");
  const baseHash = normalizeHash(input?.baseHash, "baseHash");
  const instruction = input?.instruction === undefined ? "" : nonEmptyString(input.instruction, "instruction");
  const modelPreset = input?.modelPreset === undefined ? WRITING_SKILL_DEFAULT_MODEL_PRESET : nonEmptyString(input.modelPreset, "modelPreset");
  return { sessionId, ...(turnId && versionId ? { turnId, versionId } : {}), ...(Number.isInteger(assistantMessageIndex) ? { assistantMessageIndex } : {}), skillId, markdown, baseHash, modelPreset, ...(instruction ? { instruction } : {}) };
}

function extractUrls(markdown) {
  return [...String(markdown ?? "").matchAll(/https?:\/\/[^\s)\]}>'"]+/giu)].map((match) => match[0].replace(/[.,;:!?]+$/u, ""));
}

function extractNumericTokens(markdown) {
  return [...String(markdown ?? "").matchAll(/(?<![\p{L}])\d[\d,.%/-]*/gu)].map((match) => match[0]);
}

function headingCount(markdown) {
  return String(markdown ?? "").split(/\r?\n/u).filter((line) => /^\s*#{1,6}\s+\S/u.test(line)).length;
}

export function validateWritingSkillMarkdown(original, result) {
  const source = String(original ?? "");
  const markdown = typeof result === "string" ? result.trim() : "";
  if (!markdown) throw new BrunchSkillError("invalid_skill_response", "Writing Skill returned an empty manuscript.", { status: 502, retryable: true });
  if (/^\s*##\s+Humanized\b/iu.test(markdown) || /##\s+(?:주요 변경|major changes)\b/iu.test(markdown)) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill returned a report wrapper instead of the manuscript.", { status: 502, retryable: true });
  }
  const missingUrls = extractUrls(source).filter((url) => !markdown.includes(url));
  if (missingUrls.length) throw new BrunchSkillError("invalid_skill_response", "Writing Skill removed a source link from the manuscript.", { status: 502, retryable: true });
  const missingNumbers = extractNumericTokens(source).filter((token) => !markdown.includes(token));
  if (missingNumbers.length) throw new BrunchSkillError("invalid_skill_response", "Writing Skill removed a number or date from the manuscript.", { status: 502, retryable: true });
  if (source.length >= 80 && markdown.length < Math.floor(source.length * 0.9)) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill shortened the manuscript beyond the information-preservation limit.", { status: 502, retryable: true });
  }
  if (headingCount(source) > 0 && headingCount(markdown) === 0) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill removed the manuscript heading structure.", { status: 502, retryable: true });
  }
  return markdown;
}

export function parseWritingSkillResponse(raw, originalMarkdown) {
  const text = String(raw ?? "").trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill did not return the required JSON object.", { status: 502, retryable: true });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill response must be an object.", { status: 502, retryable: true });
  }
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "markdown");
  if (unknownKeys.length) {
    throw new BrunchSkillError("invalid_skill_response", "Writing Skill response contains unsupported fields.", { status: 502, retryable: true });
  }
  return { markdown: validateWritingSkillMarkdown(originalMarkdown, parsed.markdown), parseMode: "json" };
}

export function buildWritingSkillPrompt({ bundle, title, subtitle, markdown, instruction = "", responseStyle = "" }) {
  const references = bundle.references.map((reference) => `\n--- reference: ${reference.name} ---\n${reference.content}`).join("\n");
  return [
    "당신은 한국어 브런치 블로그 원고를 다듬는 편집자입니다.",
    "도메인: 한국어 브런치 블로그 원고",
    "목적: 의미와 정보량을 보존한 문체 자연화",
    "아래 실제 Writing Skill과 reference가 지시의 원본입니다. Skill 내용을 요약하거나 별도의 규칙으로 대체하지 마세요.",
    `\n--- SKILL.md ---\n${bundle.skill.content}`,
    references,
    ...(responseStyle ? ["\n--- Brunch 사용자 노출 문체 규칙 ---", responseStyle] : []),
    ...(bundle.definition?.id === "waza"
      ? ["Waza를 사용할 때도 현재 원고의 Markdown 제목과 소제목 구조를 그대로 유지하세요. `#`·`##` 등 기존 제목 줄을 삭제하거나 평탄화하지 마세요."]
      : []),
    "\n--- 원고 문맥 ---",
    `제목: ${title}`,
    ...(subtitle ? [`부제: ${subtitle}`] : []),
    ...(instruction ? [`추가 요청: ${instruction}`] : []),
    "\n--- 현재 원고 전체 ---",
    markdown,
    "\n--- 최종 출력 지시 ---",
    "원고의 의미, 정보량, 사실, 숫자, 고유명사, 인용, URL, 문단 순서와 한국어 종결어미를 보존하세요. 원고를 요약하거나 삭제하지 마세요.",
    "Brunch 사용자 노출 문체 규칙을 적용해 상투적인 연결어, 불필요한 나열, 맞장구, 방어 문장과 과도한 설명을 제거하세요. 출력 전에 해당 문체 규칙의 점검 항목을 확인하세요.",
    "Humanizer 요청에서는 현재 원고의 필자 문체, 문장 호흡, 문단 구조와 소제목을 유지하세요. AI처럼 보이는 표현과 문장 앞의 반복 접속사만 덜어내고, 의미상 필요한 연결어까지 기계적으로 삭제하지 마세요.",
    "설명, 변경 목록, 질문, 제목 wrapper를 출력하지 마세요. 개선된 전체 원고만 markdown 문자열로 반환하세요.",
    '{"markdown":"개선된 전체 원고"} 형태의 최상위 JSON 객체 하나만 반환하세요. 다른 필드는 넣지 마세요.'
  ].join("\n");
}

function rawFromExecution(execution) {
  return execution?.raw ?? execution?.stdout ?? "";
}

function executionError(execution) {
  if (execution?.timedOut) return new BrunchSkillError("timeout", "Writing Skill generation timed out.", { status: 504, retryable: true, details: { reason: "app_server_timeout", appServerCode: execution?.code ?? null, httpStatus: 504 } });
  if (execution?.cancelled) return new BrunchSkillError("cancelled", "Writing Skill generation was cancelled.", { status: 499, retryable: true, details: { reason: "app_server_cancelled", appServerCode: execution?.code ?? null, httpStatus: 499 } });
  return new BrunchSkillError("writing_skill_failed", "Writing Skill generation failed.", { status: 502, retryable: true, details: { reason: "app_server_error", appServerCode: execution?.code ?? null, httpStatus: 502 } });
}

function targetPreview(record, input) {
  const { sessionId, turnId, versionId } = input;
  const versioned = migrateSessionToV3({ ...record, sessionId: record.sessionId ?? sessionId }, { sessionId });
  const target = turnId && versionId ? { turnId, versionId } : sessionV3TargetForMessageIndex(versioned, input.assistantMessageIndex);
  const turn = findSessionV3Turn(versioned, target?.turnId);
  const version = findSessionV3Version(turn, target?.versionId);
  const branch = versioned.branches.find((entry) => entry.branchId === versioned.activeBranchId);
  const selectedVersionId = branch?.versionSelections?.[target?.turnId] ?? turn?.activeVersionId;
  if (!turn || !version || !branch || !target?.turnId || !branch.turnIds.includes(target.turnId) || selectedVersionId !== target.versionId) {
    throw new BrunchSkillError("invalid_request", "The requested writing preview version is not active.", { status: 422, fieldErrors: { versionId: "versionId is not active." }, details: { reason: "version_mismatch", turnId: target?.turnId ?? turnId ?? null, versionId: target?.versionId ?? versionId ?? null } });
  }
  const preview = normalizeWritingPreview(version.content?.writing_preview);
  if (!preview) throw new BrunchSkillError("invalid_request", "The selected assistant version has no writing preview.", { status: 422, fieldErrors: { versionId: "writing_preview is required." }, details: { reason: "target_preview_missing", turnId: target.turnId, versionId: target.versionId } });
  return { versioned, turn, version, preview, turnId: target.turnId, versionId: target.versionId };
}

export async function refineBrunchWritingPreview({
  root,
  sessionId,
  turnId,
  versionId,
  assistantMessageIndex = null,
  skillId,
  markdown,
  baseHash,
  model = "gpt-5.6-luna",
  reasoningEffort = "medium",
  modelPreset = WRITING_SKILL_DEFAULT_MODEL_PRESET,
  sessionStore = createFileSessionStore({ root }),
  executionTransport,
  signal,
  timeoutMs = WRITING_SKILL_TIMEOUT_MS,
  instruction = "",
  skillOptions = {},
  onLog
} = {}) {
  if (!executionTransport || typeof executionTransport.executeTurn !== "function") {
    throw new BrunchSkillError("invalid_request", "Writing Skill refinement requires an App Server transport.", { status: 501, retryable: false });
  }
  const input = validateWritingRefineInput({ sessionId, turnId, versionId, assistantMessageIndex, skillId, markdown, baseHash, modelPreset, ...(instruction ? { instruction } : {}) });
  const snapshot = await withBrunchSessionLock({
    sessionStore,
    sessionId: input.sessionId,
    operation: async () => {
      const record = await sessionStore.read(input.sessionId);
      const target = targetPreview(record, input);
      const currentHash = hashWritingMarkdown(target.preview.markdown);
      if (currentHash !== input.baseHash) {
        throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being edited.", { status: 409, retryable: true, details: { reason: "preview_conflict", expectedMarkdownHash: input.baseHash, currentMarkdownHash: currentHash, turnId: target.turnId, versionId: target.versionId } });
      }
      return { title: target.preview.title, subtitle: target.preview.subtitle };
    }
  });

  const startedMs = Date.now();
  let bundle;
  try {
    bundle = loadWritingSkillBundle(input.skillId, skillOptions);
  } catch (error) {
    if (error instanceof WritingSkillError) {
      error.details ??= { reason: "skill_missing", skillId: input.skillId, httpStatus: error.status ?? 503 };
      throw error;
    }
    throw new WritingSkillError("skill_unavailable", "The requested Writing Skill is unavailable.", { status: 503, retryable: false, details: { reason: "skill_missing", skillId: input.skillId, httpStatus: 503 } });
  }
  bundle.references.forEach((reference) => onLog?.({ type: "writing_skill_reference_loaded", skillId: input.skillId, file: reference.name }));
  onLog?.({ type: "writing_skill_loaded", skillId: input.skillId, file: bundle.skill.name });
  const prompt = buildWritingSkillPrompt({ bundle, title: snapshot.title, subtitle: snapshot.subtitle, markdown: input.markdown, instruction: input.instruction, responseStyle: loadBrunchResponseStyle(root) });
  onLog?.({ type: "writing_skill_started", sessionKey: hashWritingMarkdown(input.sessionId).slice(0, 16), turnId: input.turnId, versionId: input.versionId, skillId: input.skillId, model, reasoningEffort });
  const execution = await executionTransport.executeTurn({
    root,
    prompt,
    outputSchema: buildWritingSkillOutputSchema(),
    signal,
    timeoutMs,
    model,
    reasoningEffort,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    onEvent: onLog
  });
  if (!execution || execution.code !== 0) throw executionError(execution);
  const parsed = parseWritingSkillResponse(rawFromExecution(execution), input.markdown);

  await withBrunchSessionLock({
    sessionStore,
    sessionId: input.sessionId,
    operation: async () => {
      const record = await sessionStore.read(input.sessionId);
      const target = targetPreview(record, input);
      const currentHash = hashWritingMarkdown(target.preview.markdown);
      if (currentHash !== input.baseHash) {
        throw new BrunchSkillError("preview_conflict", "The writing preview changed while it was being edited.", { status: 409, retryable: true, details: { reason: "preview_conflict", expectedMarkdownHash: input.baseHash, currentMarkdownHash: currentHash, turnId: target.turnId, versionId: target.versionId } });
      }
    }
  });

  const metadata = {
    skillId: input.skillId,
    model,
    reasoningEffort,
    modelPreset,
    durationMs: execution.durationMs ?? Date.now() - startedMs,
    parseMode: parsed.parseMode,
    baseHash: input.baseHash
  };
  onLog?.({ type: "writing_skill_finished", sessionKey: hashWritingMarkdown(input.sessionId).slice(0, 16), turnId: input.turnId, versionId: input.versionId, skillId: input.skillId, model, reasoningEffort, durationMs: metadata.durationMs, parseMode: parsed.parseMode });
  return { markdown: parsed.markdown, baseHash: input.baseHash, metadata };
}
