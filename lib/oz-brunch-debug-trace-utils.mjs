import fs from "node:fs";

const SECRET_KEY = /(authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)/iu;
const URL_SECRET = /([?&](?:token|key|secret|password|api[_-]?key|access[_-]?token)=)[^&#\s]+/giu;

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function safeSegment(value, fallback = "unknown") {
  const segment = String(value ?? "").trim().replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160);
  return segment || fallback;
}

export function bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export function redactTraceText(value) {
  return String(value ?? "")
    .replace(URL_SECRET, "$1<redacted>")
    .replace(/(Bearer\s+)[^\s]+/giu, "$1<redacted>")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*)[^\s,}]+/giu, "$1<redacted>");
}

export function redactTraceValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactTraceText(value);
  if (Array.isArray(value)) return value.map((entry) => redactTraceValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactTraceValue(entryValue, entryKey)]));
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(redactTraceValue(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function writeText(filePath, value) {
  fs.writeFileSync(filePath, `${redactTraceText(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function promptParts(prompt) {
  const text = String(prompt ?? "");
  const markers = [...text.matchAll(/(?:^|\n)---\s*([^\n-]+?)\s*---/gu)];
  if (!markers.length) return [{ name: "prompt", bytes: bytes(text) }];
  return markers.map((marker, index) => ({
    name: marker[1].trim(),
    bytes: bytes(text.slice(marker.index, markers[index + 1]?.index ?? text.length))
  }));
}

function numberOrUnknown(value) {
  return Number.isFinite(value) ? value : "unknown";
}

function usageShape(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    inputTokens: numberOrUnknown(usage.inputTokens),
    cachedInputTokens: numberOrUnknown(usage.cachedInputTokens),
    outputTokens: numberOrUnknown(usage.outputTokens),
    reasoningOutputTokens: numberOrUnknown(usage.reasoningOutputTokens),
    totalTokens: numberOrUnknown(usage.totalTokens)
  };
}

export function tokenSummary(events, executionUsage) {
  const usages = (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === "app_server_token_usage")
    .map((event) => event.tokenUsage)
    .filter(Boolean);
  const latest = usages.at(-1) ?? executionUsage ?? null;
  const last = latest?.last && typeof latest.last === "object" ? latest.last : null;
  const cumulative = latest?.total && typeof latest.total === "object" ? latest.total : null;
  return {
    notifications: usages.length,
    last: usageShape(last),
    cumulativeReported: usageShape(cumulative),
    semantics: {
      last: last ? "App Server reported last field" : "unknown",
      cumulativeReported: cumulative ? "App Server reported total field; cumulative meaning not independently verified" : "unknown"
    }
  };
}

function eventTimestamp(event) {
  const value = Date.parse(String(event?.observedAt ?? ""));
  return Number.isFinite(value) ? value : null;
}

export function timingSummary(events, stageDurationMs) {
  const searchEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === "app_server_search_event")
    .map((event) => ({ ...event, timestamp: eventTimestamp(event) }))
    .filter((event) => event.timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp);
  const pending = [];
  let searchDurationMs = 0;
  let measuredSearches = 0;
  for (const event of searchEvents) {
    if (String(event.method ?? "").endsWith("/started")) {
      pending.push(event);
      continue;
    }
    if (!String(event.method ?? "").endsWith("/completed")) continue;
    const index = pending.findIndex((start) => !event.itemId || !start.itemId || event.itemId === start.itemId);
    if (index < 0) continue;
    const [start] = pending.splice(index, 1);
    const duration = event.timestamp - start.timestamp;
    if (duration >= 0) {
      searchDurationMs += duration;
      measuredSearches += 1;
    }
  }
  return {
    stageDurationMs: Number.isFinite(stageDurationMs) ? stageDurationMs : "unknown",
    searchDurationMs: measuredSearches ? searchDurationMs : "unknown",
    modelCompletionDurationMs: "unknown",
    measurement: {
      searchPairs: measuredSearches,
      modelCompletion: "App Server notifications do not expose a model-only interval"
    }
  };
}

export function stateProjection(editorialState = null, evidenceBundle = null, stateRevision = null) {
  const state = editorialState && typeof editorialState === "object" ? editorialState : {};
  const evidenceRefs = [
    ...(Array.isArray(state.active_evidence_ids) ? state.active_evidence_ids : []),
    ...(Array.isArray(evidenceBundle?.anchor_sources) ? evidenceBundle.anchor_sources.map((entry) => entry?.id) : []),
    ...(Array.isArray(evidenceBundle?.claims) ? evidenceBundle.claims.map((entry) => entry?.id) : []),
    ...(Array.isArray(evidenceBundle?.cases) ? evidenceBundle.cases.map((entry) => entry?.id) : [])
  ].filter((entry) => typeof entry === "string" && entry.trim());
  return {
    stateRevision: Number.isInteger(stateRevision) ? stateRevision : "unknown",
    phase: state.phase ?? null,
    topic: clone(state.topic ?? null),
    topicCandidates: clone(state.topic_candidates ?? []),
    selectedTopic: clone(state.selected_topic ?? null),
    centralQuestion: state.central_question ?? null,
    editorialJudgment: state.editorial_judgment ?? null,
    title: state.title ?? null,
    titlePromise: state.title_promise ?? null,
    outline: clone(state.outline ?? null),
    confirmedUserFeedback: clone(state.confirmed_user_feedback ?? []),
    rejectedTopics: clone(state.rejected_topics ?? []),
    rejectedDirections: clone(state.rejected_directions ?? []),
    forbiddenClaims: clone(state.forbidden_claims ?? state.do_not_claim ?? []),
    activeEvidenceRefs: [...new Set(evidenceRefs)],
    articleReady: state.article_ready ?? null,
    lastUserDelta: state.last_user_delta ?? null,
    lastInteraction: {
      type: state.last_interaction_type ?? null,
      choiceLabel: state.last_choice_label ?? null
    }
  };
}

export function changedFields(before, after, reason) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .map((field) => ({
      field,
      before: clone(before?.[field]),
      after: clone(after?.[field]),
      ...(after?.[field] === null ? { reason } : {})
    }));
}
