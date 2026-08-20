export const workflowSteps = [
  ["track_selection", "발행 트랙 선택"],
  ["purpose_selection", "목적 선택"],
  ["source_selection", "자료 선택"],
  ["topic_selection", "주제 선택"],
  ["topic_refinement", "주제 다듬기"],
  ["outline_review", "목차 검토"],
  ["draft_review", "초안 검토"],
  ["publish_package_review", "최종 패키지"]
];

export const legacyWorkflowSteps = [
  ["source_review", "소스 검토"],
  ["purpose_selection", "목적 선택"],
  ["track_selection", "발행 트랙 선택"],
  ["topic_selection", "주제 선택"],
  ["topic_refinement", "주제 다듬기"],
  ["reference_review", "참고자료 검토"],
  ["outline_review", "목차 검토"],
  ["draft_review", "초안 검토"],
  ["publish_package_review", "최종 패키지"]
];

export const workflowFixtureFiles = [
  "source-review.json",
  "purpose-selection.json",
  "track-selection.json",
  "topic-selection.json",
  "topic-refinement.json",
  "reference-review.json",
  "outline-review.json",
  "draft-review.json",
  "publish-package-review.json"
];

export const stepDisplayNames = Object.fromEntries([...workflowSteps, ...legacyWorkflowSteps, ["image_prompt_review", "이미지 검토"]]);

const workflowOrder = workflowSteps.map(([id]) => id);
const fixtureWorkflowOrder = legacyWorkflowSteps.map(([id]) => id);
export const fixedGateSteps = new Set(["track_selection", "purpose_selection"]);

import { isSourceContextUsable } from "./source-policy.js";

export { canPassFinalApproval, canSupportFactualClaim, isResearchSourceSelectable, isSourceContextUsable, sourceUsagePolicy } from "./source-policy.js";

const RESEARCH_JOB_ACTIVE_STATUSES = new Set(["pending", "running"]);

function canonicalResearchUrl(value) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return raw.replace(/\/+$/u, "");
  }
}

function researchRecordId(item = {}) {
  return String(item.evidence_id ?? item.document_id ?? item.source_id ?? item.id ?? "").trim();
}

function mergeResearchRecords(currentItems = [], incomingItems = []) {
  const merged = [...currentItems];
  for (const incoming of incomingItems) {
    const incomingId = researchRecordId(incoming);
    const incomingUrl = canonicalResearchUrl(incoming.canonical_url);
    const index = merged.findIndex((item) => {
      const sameId = incomingId && researchRecordId(item) === incomingId;
      const sameUrl = incomingUrl && canonicalResearchUrl(item.canonical_url) === incomingUrl;
      return sameId || sameUrl;
    });
    if (index < 0) {
      merged.push(incoming);
      continue;
    }
    merged[index] = { ...merged[index], ...incoming };
  }
  return merged;
}

export function isResearchEvidenceSelectable(item = {}, now = Date.now()) {
  return isSourceContextUsable(item, now);
}

export function mergeResearchSelection(current = {}, incoming = {}) {
  const activeStatus = current.status_filter ?? current.filters?.status ?? "all";
  const researchEvidence = mergeResearchRecords(current.research_evidence ?? [], incoming.research_evidence ?? []);
  const pendingResearch = mergeResearchRecords(
    current.research_pending_results ?? [],
    incoming.research_pending_results ?? incoming.research_evidence?.filter((item) => item.evidence_status === "pending") ?? []
  ).filter((item) => item.evidence_status === "pending");
  return {
    ...current,
    knowledge_documents: mergeResearchRecords(current.knowledge_documents ?? [], incoming.knowledge_documents ?? []),
    research_evidence: researchEvidence,
    research_sources: mergeResearchRecords(current.research_sources ?? [], incoming.research_sources ?? []),
    ...(activeStatus === "approved" ? { research_pending_results: pendingResearch } : {})
  };
}

export function createResearchJobPoller({ jobId, getStatus, onStatus, onTerminal, onError, intervalMs = 1000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  if (!jobId || typeof getStatus !== "function") throw new Error("jobId and getStatus are required");
  const boundedInterval = Math.min(Math.max(Number(intervalMs) || 1000, 250), 10000);
  let stopped = false;
  let started = false;
  let timer = null;
  let wake = null;

  function stop() {
    stopped = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    wake?.();
    wake = null;
  }

  function waitForNextPoll() {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeoutFn(() => {
        timer = null;
        wake = null;
        resolve();
      }, boundedInterval);
    });
  }

  async function poll() {
    if (stopped) return { status: "stopped" };
    try {
      const payload = await getStatus(jobId);
      if (stopped) return { status: "stopped" };
      const status = payload?.job?.status ?? payload?.status;
      await onStatus?.(payload);
      if (!RESEARCH_JOB_ACTIVE_STATUSES.has(status)) {
        await onTerminal?.(payload);
        return payload;
      }
      await waitForNextPoll();
      return poll();
    } catch (error) {
      if (stopped) return { status: "stopped" };
      await onError?.(error);
      return { status: "error", error };
    }
  }

  return Object.freeze({
    start() {
      if (started) throw new Error("Research job poller already started");
      started = true;
      return poll();
    },
    stop
  });
}

function orderForStep(step) {
  return workflowOrder.includes(step) ? workflowOrder : fixtureWorkflowOrder;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function randomSuffix() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export function createWorkflowSessionId(kind = "live") {
  return `${kind}-workflow-${compactTimestamp()}-${randomSuffix()}`;
}

export function createWorkflowTurnId() {
  return `turn-${compactTimestamp()}-${randomSuffix()}`;
}

export function mergePlannerState(currentState, response) {
  return { ...currentState, ...(response.state_patch ?? {}) };
}

export function accumulatePlannerState(responses, selectedIndex) {
  return responses.slice(0, selectedIndex + 1).reduce((accumulated, response) => mergePlannerState(accumulated, response), {});
}

export function buildViewModel(response, accumulatedState) {
  const recommendation = response.recommendation ?? {};
  return {
    schemaVersion: response.schema_version,
    step: response.step,
    stepLabel: stepDisplayNames[response.step] ?? response.step,
    conversationMessage: response.message,
    ui: response.ui,
    stateSummary: accumulatedState,
    selectedOptionId: response.ui.options?.[0]?.id ?? "",
    recommendationReason: recommendation.reason ?? "",
    raw: response
  };
}

export function buildInitialViewModel() {
  return {
    schemaVersion: "0.4",
    step: "track_selection",
    stepLabel: stepDisplayNames.track_selection,
    conversationMessage: "새 콘텐츠를 어디에 발행할지 먼저 선택해 주세요.",
    ui: {
      component: "option_grid",
      title: "발행 트랙 선택",
      description: "발행 트랙에 따라 목적, 자료 우선순위, 글의 형식이 달라집니다.",
      options: [
        {
          id: "select_official_inblog",
          title: "공식 인블로그",
          description: "검색 가능한 정보와 명확한 구조를 중심으로 준비합니다."
        },
        {
          id: "select_brunch",
          title: "브런치",
          description: "독자의 문제의식과 경험을 따라가는 해석 중심으로 준비합니다."
        }
      ]
    },
    stateSummary: {},
    selectedOptionId: "select_official_inblog",
    recommendationReason: "",
    raw: null,
    turn: 1,
    totalTurns: workflowOrder.length
  };
}

export function createInitialWorkflowTimeline(options = {}) {
  const workflowKind = options.workflowKind ?? "live";
  return {
    workflowSessionId: options.workflowSessionId ?? createWorkflowSessionId(workflowKind),
    workflowKind,
    responses: [],
    selectedIndex: -1,
    selectedResponse: null,
    accumulated: {},
    activeStep: "track_selection",
    canGoPrevious: false,
    canGoNext: false,
    metadata: workflowSteps.map(([step, label], index) => ({
      step,
      label,
      index,
      position: index + 1
    })),
    viewModel: buildInitialViewModel()
  };
}

export function createFixtureTimeline(responses, initialStep = "topic_refinement", options = {}) {
  const sortedResponses = fixtureWorkflowOrder
    .map((step) => responses.find((response) => response.step === step))
    .filter(Boolean);
  if (sortedResponses.length !== fixtureWorkflowOrder.length) {
    const found = new Set(sortedResponses.map((response) => response.step));
    const missing = fixtureWorkflowOrder.filter((step) => !found.has(step));
    throw new Error(`Missing workflow fixture(s): ${missing.join(", ")}`);
  }
  const selectedIndex = sortedResponses.findIndex((response) => response.step === initialStep);
  if (selectedIndex < 0) {
    throw new Error(`Initial workflow step not found: ${initialStep}`);
  }
  return selectTimelineIndex(
    {
      workflowSessionId: options.workflowSessionId ?? createWorkflowSessionId("fixture"),
      workflowKind: "fixture",
      responses: sortedResponses,
      selectedIndex,
      selectedResponse: sortedResponses[selectedIndex],
      metadata: sortedResponses.map((response, index) => ({
        step: response.step,
        label: stepDisplayNames[response.step] ?? response.step,
        index,
        position: index + 1
      }))
    },
    selectedIndex
  );
}

export function createLiveTimeline(response, options = {}) {
  return selectTimelineIndex(
    {
      workflowSessionId: options.workflowSessionId ?? createWorkflowSessionId("live"),
      workflowKind: "live",
      responses: [response],
      selectedIndex: 0,
      selectedResponse: response,
      metadata: [{ step: response.step, label: stepDisplayNames[response.step] ?? response.step, index: 0, position: 1 }]
    },
    0
  );
}

export function appendTimelineResponse(timeline, response) {
  const responses = [...timeline.responses, response];
  return selectTimelineIndex(
    {
      ...timeline,
      responses,
      selectedIndex: responses.length - 1,
      selectedResponse: response,
      metadata: responses.map((item, index) => ({
        step: item.step,
        label: stepDisplayNames[item.step] ?? item.step,
        index,
        position: index + 1
      }))
    },
    responses.length - 1
  );
}

export function getNextWorkflowStep(currentStep) {
  const order = orderForStep(currentStep);
  const index = order.indexOf(currentStep);
  if (index < 0 || index >= order.length - 1) return null;
  return order[index + 1];
}

export function getSubmitTargetStep({ isStart = false, currentStep = null, freeRevise = "", selectedOptionId = "" } = {}) {
  if (isStart) {
    if (["select_brunch", "select_official_inblog"].includes(String(selectedOptionId))) return "purpose_selection";
    return "track_selection";
  }
  const explicitRevision = String(selectedOptionId).startsWith("revise_") || String(selectedOptionId).startsWith("request_") || [
    "apply_draft_revision",
    "save_draft_edit",
    "keep_draft",
    "start_claim_research",
    "retry_claim_research",
    "attach_claim_research",
    "recheck_draft"
  ].includes(String(selectedOptionId));
  if (explicitRevision) return currentStep;
  if (String(freeRevise).trim() && !fixedGateSteps.has(currentStep)) return currentStep;
  return getNextWorkflowStep(currentStep);
}

export function selectTimelineIndex(timeline, nextIndex) {
  if (timeline.responses.length === 0) {
    return createInitialWorkflowTimeline({
      workflowKind: timeline.workflowKind,
      workflowSessionId: timeline.workflowSessionId
    });
  }
  const boundedIndex = Math.min(Math.max(nextIndex, 0), timeline.responses.length - 1);
  const selectedResponse = timeline.responses[boundedIndex];
  const accumulated = accumulatePlannerState(timeline.responses, boundedIndex);
  return {
    ...timeline,
    selectedIndex: boundedIndex,
    selectedResponse,
    canGoPrevious: boundedIndex > 0,
    canGoNext: boundedIndex < timeline.responses.length - 1,
    accumulated,
    viewModel: {
      ...buildViewModel(selectedResponse, accumulated),
      turn: boundedIndex + 1,
      totalTurns: timeline.responses.length
    }
  };
}

export function previousTimeline(timeline) {
  return selectTimelineIndex(timeline, timeline.selectedIndex - 1);
}


export function selectTimelineStep(timeline, step) {
  const index = timeline.responses.findIndex((response) => response.step === step);
  if (index < 0) return timeline;
  return selectTimelineIndex(timeline, index);
}


export function nextTimeline(timeline) {
  return selectTimelineIndex(timeline, timeline.selectedIndex + 1);
}

export function workflowStatus(step, activeStep) {
  const order = orderForStep(activeStep);
  const current = order.indexOf(step);
  const active = order.indexOf(activeStep);
  if (current < active) return "done";
  if (current === active) return "active";
  return "pending";
}
