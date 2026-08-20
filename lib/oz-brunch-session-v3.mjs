import crypto from "node:crypto";
import { isCuratedBrunchRuntimeProfile } from "./oz-brunch-runtime-profile.mjs";

const SESSION_VERSION = 3;
const EDITORIAL_PHASES = new Set(["topic_discovery", "topic_research", "outline", "article", "open_editing"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assistantContent(value) {
  return clone(value);
}

function phase(value) {
  return typeof value === "string" && EDITORIAL_PHASES.has(value) ? value : null;
}

function normalizeTurnInput(value, fallbackKind = "initial") {
  if (typeof value === "string") return { inputId: id("input"), kind: fallbackKind, content: value };
  if (!value || typeof value !== "object" || typeof value.content !== "string" || !value.content.trim()) {
    throw new Error("session v3 user input must contain non-empty content");
  }
  return {
    inputId: typeof value.inputId === "string" && value.inputId ? value.inputId : id("input"),
    kind: typeof value.kind === "string" && value.kind ? value.kind : fallbackKind,
    content: value.content
  };
}

function normalizeAssistantVersion(value, fallbackModel = null, fallbackReasoningEffort = null) {
  if (!value || typeof value !== "object" || !value.content || typeof value.content !== "object") {
    throw new Error("session v3 assistant version must contain content");
  }
  return {
    versionId: typeof value.versionId === "string" && value.versionId ? value.versionId : id("version"),
    content: assistantContent(value.content),
    ...(typeof (value.model ?? fallbackModel) === "string" ? { model: value.model ?? fallbackModel } : {}),
    ...(typeof (value.reasoningEffort ?? fallbackReasoningEffort) === "string" ? { reasoningEffort: value.reasoningEffort ?? fallbackReasoningEffort } : {}),
    ...(phase(value.editorialPhaseBefore) ? { editorialPhaseBefore: value.editorialPhaseBefore } : {}),
    ...(phase(value.editorialPhaseAfter) ? { editorialPhaseAfter: value.editorialPhaseAfter } : {}),
    ...(value.curatedStateSnapshot && typeof value.curatedStateSnapshot === "object" && !Array.isArray(value.curatedStateSnapshot)
      ? { curatedStateSnapshot: clone(value.curatedStateSnapshot) }
      : {}),
    ...(value.writingReadiness && typeof value.writingReadiness === "object" && !Array.isArray(value.writingReadiness)
      ? { writingReadiness: clone(value.writingReadiness) }
      : {})
  };
}

function projectTurnMessages(turn) {
  const users = turn.userInputs.map((input) => ({ role: "user", content: input.content }));
  const active = turn.assistantVersions.find((version) => version.versionId === turn.activeVersionId)
    ?? turn.assistantVersions.at(-1);
  return active ? [...users, { role: "assistant", content: clone(active.content) }] : users;
}

function projectTurnMessagesForBranch(turn, branch) {
  const selectedVersionId = branch.versionSelections?.[turn.turnId] ?? turn.activeVersionId;
  const users = turn.userInputs.map((input) => ({ role: "user", content: input.content }));
  const active = turn.assistantVersions.find((version) => version.versionId === selectedVersionId)
    ?? turn.assistantVersions.at(-1);
  return active ? [...users, { role: "assistant", content: clone(active.content) }] : users;
}

export function isSessionV3(record) {
  return record?.sessionVersion === SESSION_VERSION
    && Array.isArray(record.branches)
    && Array.isArray(record.turns)
    && typeof record.activeBranchId === "string";
}

export function migrateSessionToV3(record, { sessionId = "", defaultModelPreset = null } = {}) {
  if (isSessionV3(record)) return clone(record);
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const turns = [];
  let pendingUsers = [];
  for (const message of messages) {
    if (message.role === "user") {
      pendingUsers.push(normalizeTurnInput(message.content, pendingUsers.length ? "steer" : "initial"));
      continue;
    }
    if (message.role !== "assistant" || !message.content || typeof message.content !== "object") {
      throw new Error("cannot migrate malformed Brunch transcript to session v3");
    }
    const userInputs = pendingUsers.length ? pendingUsers : [normalizeTurnInput("", "initial")];
    if (!userInputs[0].content.trim()) throw new Error("assistant response cannot be migrated without a preceding user message");
    const version = normalizeAssistantVersion({ content: message.content });
    turns.push({ turnId: id("turn"), userInputs, assistantVersions: [version], activeVersionId: version.versionId });
    pendingUsers = [];
  }
  if (pendingUsers.length) {
    turns.push({ turnId: id("turn"), userInputs: pendingUsers, assistantVersions: [], activeVersionId: null });
  }
  const branchId = id("branch");
  const result = {
    sessionVersion: SESSION_VERSION,
    sessionId,
    ...(typeof defaultModelPreset === "string" ? { defaultModelPreset } : {}),
    activeBranchId: branchId,
    branches: [{ branchId, parentBranchId: null, forkedFromTurnId: null, turnIds: turns.map((turn) => turn.turnId), versionSelections: {} }],
    turns,
    messages: [],
    ...(record?.editorial_state && typeof record.editorial_state === "object" ? { editorial_state: clone(record.editorial_state) } : {}),
    ...(record?.evidence_bundle && typeof record.evidence_bundle === "object" ? { evidence_bundle: clone(record.evidence_bundle) } : {}),
    ...(record?.title_research_sources && typeof record.title_research_sources === "object" ? { title_research_sources: clone(record.title_research_sources) } : {})
  };
  result.messages = projectActiveMessages(result);
  return result;
}

export function projectActiveMessages(record) {
  const branch = record.branches.find((entry) => entry.branchId === record.activeBranchId);
  if (!branch) throw new Error("session v3 active branch does not exist");
  const turnsById = new Map(record.turns.map((turn) => [turn.turnId, turn]));
  return branch.turnIds.flatMap((turnId) => {
    const turn = turnsById.get(turnId);
    if (!turn) throw new Error("session v3 branch references an unknown turn");
    return projectTurnMessagesForBranch(turn, branch);
  });
}

export function appendSessionV3Turn(record, { userMessages, response, model = null, reasoningEffort = null, modelPreset = null, editorialPhaseBefore = null, editorialPhaseAfter = null, curatedStateSnapshot = null } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "", defaultModelPreset: modelPreset });
  const inputs = (Array.isArray(userMessages) ? userMessages : []).map((entry, index) => normalizeTurnInput(entry, index ? "steer" : "initial"));
  if (!inputs.length) throw new Error("session v3 turn needs a user input");
  const version = normalizeAssistantVersion({ content: response, model, reasoningEffort, editorialPhaseBefore, editorialPhaseAfter, curatedStateSnapshot }, model, reasoningEffort);
  const turn = { turnId: id("turn"), userInputs: inputs, assistantVersions: [version], activeVersionId: version.versionId };
  const branch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  if (!branch) throw new Error("session v3 active branch does not exist");
  next.turns.push(turn);
  branch.turnIds.push(turn.turnId);
  if (!next.defaultModelPreset && modelPreset) next.defaultModelPreset = modelPreset;
  next.messages = projectActiveMessages(next);
  return next;
}

export function findSessionV3Turn(record, turnId) {
  return record.turns.find((turn) => turn.turnId === turnId) ?? null;
}

export function findSessionV3Version(turn, versionId) {
  return turn?.assistantVersions.find((version) => version.versionId === versionId) ?? null;
}

export function sessionV3VersionSummaries(record, { turnId } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const turn = findSessionV3Turn(next, turnId);
  if (!turn) return [];
  return turn.assistantVersions.map((version, index) => ({
    versionId: version.versionId,
    index,
    active: version.versionId === turn.activeVersionId,
    ...(typeof version.model === "string" ? { model: version.model } : {}),
    ...(typeof version.reasoningEffort === "string" ? { reasoningEffort: version.reasoningEffort } : {}),
    ...((isCuratedBrunchRuntimeProfile(next.runtimeProfile) || version.curatedStateSnapshot?.editorial_state)
      ? { restoreAvailable: Boolean(version.curatedStateSnapshot?.editorial_state) }
      : {}),
    ...(version.writingReadiness && typeof version.writingReadiness === "object" ? { writingReadiness: clone(version.writingReadiness) } : {})
  }));
}

export function sessionV3TurnHistory(record, turnId) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const branch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  const turnIndex = branch?.turnIds.indexOf(turnId) ?? -1;
  if (!branch || turnIndex < 0) throw new Error("session v3 turn is not on the active branch");
  const turnsById = new Map(next.turns.map((turn) => [turn.turnId, turn]));
  const precedingMessages = branch.turnIds.slice(0, turnIndex).flatMap((idValue) => {
    const turn = turnsById.get(idValue);
    if (!turn) throw new Error("session v3 branch references an unknown turn");
    return projectTurnMessagesForBranch(turn, branch);
  });
  return { record: next, turn: turnsById.get(turnId), precedingMessages };
}

export function sessionV3TargetForMessageIndex(record, messageIndex) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const branch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  if (!branch || !Number.isInteger(messageIndex) || messageIndex < 0) return null;
  const turnsById = new Map(next.turns.map((turn) => [turn.turnId, turn]));
  let cursor = 0;
  for (const turnId of branch.turnIds) {
    const turn = turnsById.get(turnId);
    if (!turn) return null;
    cursor += turn.userInputs.length;
    if (turn.assistantVersions.length && cursor === messageIndex) {
      return { turnId, versionId: branch.versionSelections?.[turnId] ?? turn.activeVersionId };
    }
    if (turn.assistantVersions.length) cursor += 1;
  }
  return null;
}

export function activateSessionV3Version(record, { turnId, versionId } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const turn = findSessionV3Turn(next, turnId);
  const version = findSessionV3Version(turn, versionId);
  if (!turn || !version) throw new Error("session v3 version does not exist");
  const branch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  if (!branch || !branch.turnIds.includes(turnId)) throw new Error("session v3 version turn is not on the active branch");
  branch.versionSelections = { ...(branch.versionSelections ?? {}), [turnId]: version.versionId };
  const selectedPhase = phase(version.editorialPhaseAfter) ?? phase(version.editorialPhaseBefore);
  if (selectedPhase) next.editorial_state = { ...(next.editorial_state ?? {}), phase: selectedPhase };
  next.messages = projectActiveMessages(next);
  return next;
}

export function addSessionV3AssistantVersion(record, { turnId, response, model = null, reasoningEffort = null, additionalUserInputs = [], editorialPhaseBefore = null, editorialPhaseAfter = null, curatedStateSnapshot = null } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const turn = findSessionV3Turn(next, turnId);
  if (!turn) throw new Error("session v3 turn does not exist");
  additionalUserInputs.forEach((entry) => turn.userInputs.push(normalizeTurnInput(entry, "steer")));
  const version = normalizeAssistantVersion({ content: response, model, reasoningEffort, editorialPhaseBefore, editorialPhaseAfter, curatedStateSnapshot }, model, reasoningEffort);
  turn.assistantVersions.push(version);
  const branch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  branch.versionSelections = { ...(branch.versionSelections ?? {}), [turnId]: version.versionId };
  next.messages = projectActiveMessages(next);
  return { record: next, version };
}

export function branchSessionV3(record, { turnId, versionId } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const sourceBranch = next.branches.find((entry) => entry.branchId === next.activeBranchId);
  const sourceTurnIndex = sourceBranch?.turnIds.indexOf(turnId) ?? -1;
  const turn = findSessionV3Turn(next, turnId);
  if (!sourceBranch || sourceTurnIndex < 0 || !turn || !findSessionV3Version(turn, versionId)) {
    throw new Error("session v3 branch source does not exist");
  }
  const branchId = id("branch");
  const versionSelections = { ...(sourceBranch.versionSelections ?? {}), [turnId]: versionId };
  next.branches.push({
    branchId,
    parentBranchId: sourceBranch.branchId,
    forkedFromTurnId: turnId,
    turnIds: sourceBranch.turnIds.slice(0, sourceTurnIndex + 1),
    versionSelections
  });
  next.activeBranchId = branchId;
  const selectedVersion = findSessionV3Version(turn, versionId);
  const selectedPhase = phase(selectedVersion?.editorialPhaseAfter) ?? phase(selectedVersion?.editorialPhaseBefore);
  if (selectedPhase) next.editorial_state = { ...(next.editorial_state ?? {}), phase: selectedPhase };
  next.messages = projectActiveMessages(next);
  return next;
}

export function restoreSessionV3Version(record, { turnId, versionId } = {}) {
  const versioned = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const turn = findSessionV3Turn(versioned, turnId);
  const version = findSessionV3Version(turn, versionId);
  if (!turn || !version) throw new Error("session v3 version does not exist");
  const snapshot = version.curatedStateSnapshot;
  if (!snapshot || !snapshot.editorial_state || typeof snapshot.editorial_state !== "object" || Array.isArray(snapshot.editorial_state)) {
    const error = new Error("curated state snapshot does not exist");
    error.code = "state_snapshot_unavailable";
    throw error;
  }
  const next = branchSessionV3(versioned, { turnId, versionId });
  next.editorial_state = clone(snapshot.editorial_state);
  if (snapshot.title_research_sources && typeof snapshot.title_research_sources === "object" && !Array.isArray(snapshot.title_research_sources)) {
    next.title_research_sources = clone(snapshot.title_research_sources);
  } else {
    delete next.title_research_sources;
  }
  next.messages = projectActiveMessages(next);
  return next;
}

export function replaceSessionV3Preview(record, { turnId, versionId, writing_preview } = {}) {
  const next = migrateSessionToV3(record, { sessionId: record?.sessionId ?? "" });
  const turn = findSessionV3Turn(next, turnId);
  const version = findSessionV3Version(turn, versionId);
  if (!turn || !version || !version.content.writing_preview) throw new Error("session v3 preview target does not exist");
  version.content.writing_preview = clone(writing_preview);
  delete version.writingReadiness;
  next.messages = projectActiveMessages(next);
  return next;
}

export function sessionV3Metadata(record) {
  const { messages: _messages, ...metadata } = clone(record);
  return metadata;
}

export const BRUNCH_SESSION_VERSION = SESSION_VERSION;
