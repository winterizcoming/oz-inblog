import { appendTimelineResponse, createFixtureTimeline, createLiveTimeline, workflowFixtureFiles } from "./state.js";
import { normalizeBrunchChatMessages, normalizeBrunchChatResponse, normalizeBrunchChatWritingPreview } from "./brunch-chat-state.js";

const WRITING_SKILL_DEFAULT_MODEL_PRESET = "luna-medium";

function normalizeBrunchChatNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!(error instanceof TypeError) && !/failed to fetch|network|fetch/i.test(message)) return error;
  const normalized = new Error("Brunch chat server is unavailable.", { cause: error });
  normalized.code = "network_unavailable";
  return normalized;
}

function attachBrunchChatMetadata(result, payload = {}) {
  if (!result) return result;
  if (Array.isArray(payload.versionSummaries)) Object.defineProperty(result, "versionSummaries", { value: payload.versionSummaries, enumerable: false });
  for (const key of ["runtimeProfile", "restoreAvailable"]) {
    if (payload[key] !== undefined) Object.defineProperty(result, key, { value: payload[key], enumerable: false });
  }
  return result;
}

function readVersionSummaries(response) {
  const raw = response?.headers?.get?.("x-oz-version-summaries");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function waitForBrunchGenerationPoll(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}

export class FixtureProvider {
  async respond(request = {}) {
    const fixture = request.fixture ?? "topic-refinement.json";
    const response = await fetch(`/api/examples/${encodeURIComponent(fixture)}`);
    if (!response.ok) {
      throw new Error(`FixtureProvider failed: ${response.status}`);
    }
    return response.json();
  }

  async loadTimeline(request = {}) {
    const responses = await Promise.all(workflowFixtureFiles.map((fixture) => this.respond({ fixture })));
    return createFixtureTimeline(responses, request.initialStep ?? "topic_refinement", {
      workflowSessionId: request.workflowSessionId
    });
  }
}

export class CodexProvider {
  async createV06Session(researchScope = {}) {
    const response = await fetch("/api/v06/sessions/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(researchScope)
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `v0.6 session creation failed: ${response.status}`);
      error.field_errors = payload.field_errors ?? {};
      throw error;
    }
    return payload;
  }

  async listWorkflowSessions({ limit = 20, cursor = "", filter = "all" } = {}) {
    const params = new URLSearchParams({ limit: String(limit), filter });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`/api/workflow/sessions?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Failed to list workflow sessions: ${response.status}`);
    return payload;
  }

  async listBrunchChatSessions({ limit = 50 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    const response = await fetch(`/api/oz-brunch-chat/sessions?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? payload.message ?? `Failed to list Brunch chat sessions: ${response.status}`);
    return payload;
  }

  async loadBrunchChatSession(sessionId) {
    const response = await fetch(`/api/oz-brunch-chat/sessions/${encodeURIComponent(sessionId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? payload.message ?? `Failed to load Brunch chat session: ${response.status}`);
    return payload;
  }

  async loadWorkflowSessionDetail(sessionId) {
    const response = await fetch(`/api/workflow/sessions/${encodeURIComponent(sessionId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Failed to load workflow session: ${response.status}`);
    return payload;
  }

  async loadV06Operator(sessionId) {
    const response = await fetch(`/api/v06/sessions/${encodeURIComponent(sessionId)}/operator`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? payload.message ?? `Failed to load v0.6 Operator Session: ${response.status}`);
    return payload;
  }

  async runV06OperatorAction(sessionId, input = {}) {
    const response = await fetch(`/api/v06/sessions/${encodeURIComponent(sessionId)}/operator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `v0.6 Operator action failed: ${response.status}`);
    return payload;
  }

  async loadV06OperatorRuns(sessionId) {
    const response = await fetch(`/api/v06/sessions/${encodeURIComponent(sessionId)}/operator/runs`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Failed to load v0.6 Operator runs: ${response.status}`);
    return payload;
  }

  async restoreWorkflowSession(sessionId) {
    const response = await fetch(`/api/workflow/sessions/${encodeURIComponent(sessionId)}/restore`, { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Failed to restore workflow session: ${response.status}`);
    return payload;
  }

  async searchResearch(input = {}) {
    const response = await fetch("/api/research/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Research search failed: ${response.status}`);
    return payload;
  }

  async searchKnowledge(input = {}) {
    const response = await fetch("/api/knowledge/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Knowledge search failed: ${response.status}`);
    return payload;
  }

  async getResearchEvidenceDetail(evidenceId) {
    const response = await fetch(`/api/research/evidence/${encodeURIComponent(evidenceId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Research evidence detail failed: ${response.status}`);
    return payload;
  }

  async reviewResearchEvidence(input = {}) {
    const response = await fetch("/api/research/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Research review failed: ${response.status}`);
    return payload;
  }

  async getResearchJobStatus(jobId) {
    const response = await fetch(`/api/research/jobs/${encodeURIComponent(jobId)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Research job status failed: ${response.status}`);
    return payload;
  }

  async probe() {
    const response = await fetch("/api/provider/codex/probe", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || payload.status === "blocked") {
      throw new Error(payload.reason ?? "CodexProvider unavailable");
    }
    return payload;
  }

  async respond(request, options = {}) {
    const response = await fetch("/api/provider/codex/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal
    });
    const payload = await response.json();
    if (!response.ok || payload.status === "blocked") {
      throw new Error(payload.reason ?? "CodexProvider respond failed");
    }
    return payload;
  }

  async respondBrunchChat({ sessionId, message, generationId, modelPreset, interaction } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, message, generationId, ...(modelPreset ? { modelPreset } : {}), ...(interaction ? { interaction } : {}) }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch chat failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    const activeGenerationId = payload.generationId ?? generationId;
    let completed = payload;
    while (completed.status === "running" || completed.status === "interrupting") {
      await waitForBrunchGenerationPoll(Number.isFinite(options.pollIntervalMs) ? Math.max(0, options.pollIntervalMs) : 1200, options.signal);
      completed = await this.getBrunchChatGenerationStatus({ sessionId, generationId: activeGenerationId }, options);
      options.onStatus?.(completed);
    }
    if (completed.status === "failed" || completed.status === "interrupted") {
      const failure = completed.error ?? {};
      const error = new Error(failure.message ?? `Brunch generation ${completed.status}.`);
      error.code = failure.code ?? completed.status;
      error.status = completed.status === "interrupted" ? 409 : 502;
      error.retryable = failure.retryable ?? true;
      throw error;
    }
    const result = normalizeBrunchChatResponse(completed.response);
    if (!result) {
      throw new Error("Brunch chat returned an invalid response.");
    }
    const metadata = completed.metadata ?? {};
    Object.defineProperties(result, {
      generationId: { value: activeGenerationId, enumerable: false },
      turnId: { value: metadata.turnId, enumerable: false },
      versionId: { value: metadata.versionId, enumerable: false },
      branchId: { value: metadata.branchId, enumerable: false },
      editorialPhase: { value: metadata.editorialPhase, enumerable: false },
      editorialPhaseAfter: { value: metadata.editorialPhaseAfter ?? metadata.editorialPhase, enumerable: false },
      runtimeProfile: { value: metadata.runtimeProfile, enumerable: false },
      restoreAvailable: { value: metadata.restoreAvailable, enumerable: false }
    });
    return attachBrunchChatMetadata(result, { ...completed.response, versionSummaries: metadata.versionSummaries ?? [], runtimeProfile: metadata.runtimeProfile, restoreAvailable: metadata.restoreAvailable });
  }

  async getBrunchChatGenerationStatus({ sessionId, generationId } = {}, options = {}) {
    let response;
    try {
      const query = new URLSearchParams({ sessionId: sessionId ?? "" });
      response = await fetch(`/api/oz-brunch-chat/generations/${encodeURIComponent(generationId ?? "")}?${query}`, { signal: options.signal });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch generation status failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async steerBrunchChat({ sessionId, generationId, message } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/steer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, generationId, message }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch steer failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async abortBrunchChat({ sessionId, generationId } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, generationId }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch abort failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async getBrunchChatCapabilities() {
    const response = await fetch("/api/oz-brunch-chat/capabilities");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Brunch capabilities failed: ${response.status}`);
    return payload;
  }

  async regenerateBrunchChat({ sessionId, turnId, sourceVersionId, modelPreset, generationId } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/regenerate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, turnId, sourceVersionId, ...(modelPreset ? { modelPreset } : {}), ...(generationId ? { generationId } : {}) }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch regeneration failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    const result = normalizeBrunchChatResponse(payload);
    if (!result) throw new Error("Brunch regeneration returned an invalid response.");
    Object.defineProperties(result, {
      turnId: { value: payload.turnId, enumerable: false },
      sourceVersionId: { value: payload.sourceVersionId, enumerable: false },
      versionId: { value: payload.versionId, enumerable: false },
      generationId: { value: payload.generationId, enumerable: false }
    });
    return attachBrunchChatMetadata(result, payload);
  }

  async activateBrunchChatVersion({ sessionId, turnId, versionId } = {}, options = {}) {
    return this.#brunchVersionAction("/api/oz-brunch-chat/activate-version", { sessionId, turnId, versionId }, options);
  }

  async restoreBrunchChatVersion({ sessionId, turnId, versionId } = {}, options = {}) {
    return this.#brunchVersionAction("/api/oz-brunch-chat/restore-version", { sessionId, turnId, versionId }, options);
  }

  async branchBrunchChat({ sessionId, turnId, versionId } = {}, options = {}) {
    return this.#brunchVersionAction("/api/oz-brunch-chat/branch", { sessionId, turnId, versionId }, options);
  }

  async #brunchVersionAction(url, body, options = {}) {
    let response;
    try {
      response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: options.signal });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch version action failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    if (payload.response) {
      const response = normalizeBrunchChatResponse(payload.response);
      if (!response) throw new Error("Brunch version action returned an invalid response.");
      return { ...payload, response };
    }
    if (Array.isArray(payload.messages)) {
      return { ...payload, messages: normalizeBrunchChatMessages(payload.messages) };
    }
    return payload;
  }

  async patchBrunchChatPreview({ sessionId, assistantMessageIndex, turnId, versionId, expectedMarkdownHash, writing_preview } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/preview", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...(Number.isInteger(assistantMessageIndex) ? { assistantMessageIndex } : {}), ...(turnId ? { turnId } : {}), ...(versionId ? { versionId } : {}), ...(expectedMarkdownHash ? { expectedMarkdownHash } : {}), writing_preview }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Brunch preview patch failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    const preview = normalizeBrunchChatWritingPreview(payload.writing_preview);
    if (!preview) throw new Error("Brunch preview patch returned an invalid response.");
    return preview;
  }

  async getBrunchWritingSkills() {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/preview/skills");
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Writing Skill capabilities failed: ${response.status}`);
    return { skills: Array.isArray(payload.skills) ? payload.skills.filter((skill) => skill && typeof skill.id === "string" && typeof skill.label === "string") : [] };
  }

  async refineBrunchChatPreview({ sessionId, turnId, versionId, assistantMessageIndex, skillId, markdown, baseHash, modelPreset = WRITING_SKILL_DEFAULT_MODEL_PRESET, instruction } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/preview/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...(turnId ? { turnId } : {}), ...(versionId ? { versionId } : {}), ...(Number.isInteger(assistantMessageIndex) ? { assistantMessageIndex } : {}), skillId, markdown, baseHash, ...(modelPreset ? { modelPreset } : {}), ...(instruction ? { instruction } : {}) }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Writing Skill refinement failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      error.field_errors = payload.field_errors ?? {};
      throw error;
    }
    if (!payload || typeof payload.markdown !== "string" || !payload.markdown.trim()) throw new Error("Writing Skill returned an invalid manuscript.");
    return { markdown: payload.markdown, baseHash: payload.baseHash, metadata: payload.metadata ?? {} };
  }

  async evaluateBrunchChatReadiness({ sessionId, turnId, versionId, previewHash } = {}, options = {}) {
    let response;
    try {
      response = await fetch("/api/oz-brunch-chat/preview/readiness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, turnId, versionId, previewHash }),
        signal: options.signal
      });
    } catch (error) {
      throw normalizeBrunchChatNetworkError(error);
    }
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? `Writing readiness evaluation failed: ${response.status}`);
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    if (!payload?.readiness || typeof payload.readiness !== "object") throw new Error("Writing readiness returned an invalid result.");
    return payload;
  }

  async loadTimeline(request = {}) {
    const sessionId = request.workflowSessionId;
    if (!sessionId) {
      throw new Error("workflowSessionId is required to load a Codex timeline.");
    }

    const response = await fetch(`/api/workflow/sessions/${encodeURIComponent(sessionId)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error ?? `Failed to load workflow session: ${response.status}`);
    }

    const responses = payload.responses ?? [];
    if (!responses.length) {
      const initial = createLiveTimeline({
        schema_version: payload.schema_version ?? "0.4",
        route: "new_content",
        step: payload.current_step ?? "track_selection",
        message: "이 세션에는 복원 가능한 Planner 응답이 없습니다. 기록 열람만 가능합니다.",
        ui: { component: "option_grid", title: "읽기 전용 세션", description: "이벤트와 artifact를 확인할 수 있습니다.", options: [] },
        state_patch: payload.state ?? {}
      }, { workflowSessionId: payload.workflow_session_id ?? sessionId });
      return { ...initial, requestHistory: payload.requests ?? [], sessionWarnings: payload.warnings ?? [], readOnly: true, sessionDetail: payload };
    }

    const timeline = responses
      .slice(1)
      .reduce(
        (currentTimeline, item) => appendTimelineResponse(currentTimeline, item),
        createLiveTimeline(responses[0], {
          workflowSessionId: payload.workflowSessionId ?? sessionId
        })
      );

    return {
      ...timeline,
      requestHistory: payload.requests ?? [],
      sessionWarnings: payload.warnings ?? [],
      readOnly: payload.read_only === true,
      sessionDetail: payload
    };
  }
}

export class OpenAIProvider {
  async respond() {
    throw new Error("OpenAIProvider is an interface stub in v0.3.");
  }
}

export function createPlannerProvider(name = "fixture") {
  if (name === "fixture") return new FixtureProvider();
  if (name === "codex") return new CodexProvider();
  if (name === "openai") return new OpenAIProvider();
  throw new Error(`Unknown provider: ${name}`);
}
