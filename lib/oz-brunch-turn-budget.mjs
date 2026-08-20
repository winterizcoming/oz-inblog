export const DEFAULT_WHOLE_TURN_TIMEOUT_MS = 600_000;
export const DEFAULT_RESEARCH_CUTOFF_MS = 360_000;
export const DEFAULT_FINAL_RESPONSE_RESERVE_MS = 240_000;
export const DEFAULT_FINISH_GRACE_MS = 120_000;
export const DEFAULT_REVIEW_MIN_REMAINING_MS = 90_000;

export const BRUNCH_OPERATION_TIMEOUTS = Object.freeze({
  topic_discovery: 900_000,
  topic_retry: 900_000,
  topic_research: 1_800_000,
  outline: 600_000,
  article: 1_200_000,
  local_edit: 360_000,
  structural_edit: 720_000,
  full_rewrite: 1_200_000,
  evidence_update: 1_500_000,
  writing_skill: 600_000,
  readiness: 480_000,
  curated_topic_discovery: 900_000,
  curated_topic_research: 120_000
});

export const BRUNCH_STAGE_TIMEOUTS = Object.freeze({
  source_discovery: 480_000,
  research: 600_000,
  edit: 600_000,
  review: 120_000
});

export const BRUNCH_OPERATION_STAGE_TIMEOUTS = Object.freeze({
  topic_discovery: Object.freeze({ source_discovery: 480_000, edit: 360_000 }),
  topic_retry: Object.freeze({ source_discovery: 480_000, edit: 360_000 }),
  topic_research: Object.freeze({ source_discovery: 480_000, research: 600_000, edit: 360_000 }),
  outline: Object.freeze({ edit: 600_000 }),
  article: Object.freeze({ edit: 1_200_000 }),
  local_edit: Object.freeze({ edit: 360_000 }),
  structural_edit: Object.freeze({ edit: 300_000 }),
  full_rewrite: Object.freeze({ edit: 1_200_000 }),
  evidence_update: Object.freeze({ source_discovery: 480_000, research: 600_000, edit: 360_000 }),
  curated_topic_discovery: Object.freeze({ source_discovery: 600_000, edit: 300_000 }),
  curated_topic_research: Object.freeze({ research: 90_000, edit: 30_000 })
});

export function stageTimeoutsForBrunchOperation(operation) {
  return BRUNCH_OPERATION_STAGE_TIMEOUTS[operation] ?? BRUNCH_STAGE_TIMEOUTS;
}

export const BRUNCH_FINISH_GRACE = Object.freeze({
  source_discovery: 180_000,
  research: 240_000,
  edit: 240_000,
  review: 60_000
});

export function timeoutForBrunchOperation(operation, fallback = DEFAULT_WHOLE_TURN_TIMEOUT_MS) {
  return BRUNCH_OPERATION_TIMEOUTS[operation] ?? fallback;
}

export function createBrunchTurnBudget({
  timeoutMs = DEFAULT_WHOLE_TURN_TIMEOUT_MS,
  researchCutoffMs = DEFAULT_RESEARCH_CUTOFF_MS,
  finalResponseReserveMs = DEFAULT_FINAL_RESPONSE_RESERVE_MS,
  finishGraceMs = DEFAULT_FINISH_GRACE_MS,
  reviewMinRemainingMs = DEFAULT_REVIEW_MIN_REMAINING_MS,
  stageTimeouts = null,
  stageFinishGraceMs = null,
  now = () => Date.now()
} = {}) {
  const startedAt = now();
  const totalMs = Math.max(1, Number(timeoutMs) || DEFAULT_WHOLE_TURN_TIMEOUT_MS);
  const deadline = startedAt + totalMs;
  const reserveBound = deadline - Math.max(0, Number(finalResponseReserveMs) || 0);
  const researchDeadline = Math.min(
    deadline,
    startedAt + Math.max(1, Number(researchCutoffMs) || DEFAULT_RESEARCH_CUTOFF_MS),
    reserveBound > startedAt ? reserveBound : deadline
  );
  const finishRequests = new Set();
  const stageWindows = new Map();

  const remainingMs = () => Math.max(0, deadline - now());
  const stageDeadline = (stage) => stageWindows.get(stage)?.deadline
    ?? (["source_discovery", "research"].includes(stage) ? researchDeadline : deadline);
  const stageRemainingMs = (stage) => Math.max(0, stageDeadline(stage) - now());
  const finishAt = (stage) => {
    const grace = stageFinishGraceMs?.[stage] ?? finishGraceMs;
    return Math.max(startedAt, stageDeadline(stage) - Math.max(0, Number(grace) || 0));
  };

  return {
    startedAt,
    deadline,
    researchDeadline,
    totalMs,
    remainingMs,
    stageRemainingMs,
    beginStage(stage, requestedTimeoutMs = stageTimeouts?.[stage] ?? null) {
      if (!stageWindows.has(stage)) {
        const requested = Number(requestedTimeoutMs);
        const duration = Number.isFinite(requested) && requested > 0 ? requested : null;
        stageWindows.set(stage, { startedAt: now(), deadline: duration ? Math.min(deadline, now() + duration) : stageDeadline(stage) });
      }
      return stageWindows.get(stage);
    },
    timeoutForStage(stage, requestedTimeoutMs = totalMs) {
      const profile = stageTimeouts?.[stage];
      if (profile && !stageWindows.has(stage)) this.beginStage(stage, profile);
      const requested = Math.max(1, Number(requestedTimeoutMs) || totalMs);
      return Math.max(1, Math.min(requested, stageRemainingMs(stage)));
    },
    msUntilFinish(stage) {
      return Math.max(0, finishAt(stage) - now());
    },
    shouldSkipReview() {
      return remainingMs() < Math.max(0, Number(reviewMinRemainingMs) || 0);
    },
    shouldStopResearch() {
      return stageRemainingMs("research") <= 0;
    },
    markFinishRequested(stage) {
      if (finishRequests.has(stage)) return false;
      finishRequests.add(stage);
      return true;
    },
    snapshot() {
      return {
        elapsedMs: Math.max(0, now() - startedAt),
        remainingMs: remainingMs(),
        researchRemainingMs: stageRemainingMs("research"),
        finishRequestedStages: [...finishRequests],
        stages: Object.fromEntries([...stageWindows.entries()].map(([stage, value]) => [stage, {
          startedAt: value.startedAt,
          remainingMs: Math.max(0, value.deadline - now())
        }]))
      };
    }
  };
}
