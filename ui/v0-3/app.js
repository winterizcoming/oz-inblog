import { createPlannerProvider } from "./providers.js";
import {
  appendTimelineResponse,
  createResearchJobPoller,
  createInitialWorkflowTimeline,
  createLiveTimeline,
  createWorkflowSessionId,
  createWorkflowTurnId,
  getNextWorkflowStep,
  getSubmitTargetStep,
  isResearchEvidenceSelectable,
  isResearchSourceSelectable,
  nextTimeline,
  previousTimeline,
  selectTimelineIndex,
  selectTimelineStep
} from "./state.js";
import { createDrawerController } from "./drawers.js";
import { createPanelController, renderBrunchReadinessSummary, syncBrunchChatDraftUi } from "./panels.js";
import { createProviderStatusController } from "./provider-status.js";
import { bindPanelResizer } from "./resizer.js";
import { escapeHtml, resolveResearchCtaQuery } from "./renderers.js";
import { applyMarkdownShortcut, editorHtmlToMarkdown, markdownToEditorHtml } from "./writing-editor-markdown.js";
import { copyCatalog } from "../copy-catalog.js";
import {
  chooseBrunchChatMessage,
  BRUNCH_CHAT_DEFAULT_MODEL_PRESET,
  brunchChatWelcome,
  createBrunchChatState,
  defaultBrunchChatChoiceIndex,
  BrunchChatStorageError,
  persistBrunchChatState,
  readBrunchChatStorage,
  isBrunchChatRequestAborted,
  normalizeBrunchChatMessages,
  isCuratedBrunchChatProfile
} from "./brunch-chat-state.js";
import { applySourceSelectionChange, applySourceSelectionProjection, buildSourceSelectionProjection, clearSourceSelection } from "./source-selection-projection.js";
import { renderV06Operator, renderV06Start } from "./v06-operator.js";
import { V06_OPERATOR_COPY } from "./v06-operator-copy.js";
import { stripBrunchSourcesForCopy } from "./brunch-copy.js";

const fixtureProvider = createPlannerProvider("fixture");
const codexProvider = createPlannerProvider("codex");
const supportedDeterministicRuntimeVersions = new Set(["0.4.5", "0.5"]);
const state = {
  mode: "brunch-chat",
  brunchChat: createBrunchChatState(),
  v06: {
    sessionId: null,
    operator: null,
    selectedStep: null,
    selectedFindingId: null,
    selectedClaimId: null,
    selectedNoteId: null,
    selectedSourceId: null,
    selectedDirectionId: null,
    detailModal: null,
    detailTrigger: null,
    detailTriggerRegion: null,
    editing: null,
    busy: false,
    notice: null,
    activeRuns: [],
    start: null
  },
  timeline: createInitialWorkflowTimeline(),
  conversationTurns: [],
  isGenerating: false,
  generatingElapsedSeconds: 0,
  pendingTurn: null,
  lastFailedRequestSignature: null,
  workflowNotice: null,
  workflowCompleted: false,
  selectionRevealPending: false,
  rightRevealPending: false,
  shouldScrollConversation: false,
  conversationScrollTarget: null,
  forceHistorySelection: false,
  sourceSelectionMutationSequence: 0,
  sourceSearchSequence: 0,
  sourceSelectionSavePending: false
  ,researchRequestPending: false
};

let generationTimerId = null;
let generationAbortController = null;
let assistantRevealTimerIds = [];
let selectionRevealTimerIds = [];
let rightRevealTimerIds = [];
let researchJobPoller = null;
let researchPollPromise = null;
let claimResearchJobPoller = null;
let claimResearchPollPromise = null;
let v06RunPollingTimer = null;
let brunchChatPendingMessages = null;
let brunchChatScrollMode = "initial";
let brunchChatScrollAnchorKey = "";
let brunchChatHistoryScrollMode = "initial";
let brunchChatScrollEpoch = 0;
let writingEditorReturnFocus = null;
let writingEditorPendingSave = null;
let brunchChatStorageRestoreError = null;
let brunchChatVersionActionPending = false;
let brunchWritingSkillsPromise = null;

const nodes = {
  left: document.querySelector(".left-rail"),
  workflowToggle: document.querySelector("#workflowToggle"),
  center: document.querySelector(".conversation-panel"),
  resizer: document.querySelector("#panelResizer"),
  right: document.querySelector(".right-panel"),
  articleDrawer: document.querySelector("#articleDrawer"),
  debugDrawer: document.querySelector("#debugDrawer"),
  backdrop: document.querySelector(".drawer-backdrop"),
  articleList: document.querySelector(".article-list"),
  createWorkflow: document.querySelector("#createWorkflow"),
  sessionFilter: document.querySelector("#sessionFilter"),
  debugJson: document.querySelector(".debug-json"),
  providerStatus: document.querySelector("#providerStatus"),
  providerPopover: document.querySelector("#providerPopover"),
  providerStateText: document.querySelector("#providerStateText"),
  providerMessage: document.querySelector("#providerMessage"),
  connectCodex: document.querySelector("#connectCodex"),
  disconnectCodex: document.querySelector("#disconnectCodex")
};

function currentViewModel() {
  return state.timeline.viewModel;
}

function setWorkflowNotice(type, message) {
  state.workflowNotice = { type, message };
}

function clearWorkflowNotice() {
  state.workflowNotice = null;
}

function setUrlSession(sessionId) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionId);
  window.history.replaceState({}, "", url);
}

function clearUrlSession() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("session")) return;
  url.searchParams.delete("session");
  window.history.replaceState({}, "", url);
}

function createV06StartDraft() {
  return {
    subject: "",
    seed_urls: "",
    initial_interest: "",
    comparison_hints: "",
    editor_notes: "",
    research_depth: "standard",
    source_count_min: "",
    source_count_preferred: "",
    source_count_max: ""
  };
}

function createV06StartState() {
  return { status: "idle", draft: createV06StartDraft(), errors: {}, message: "", requestId: crypto.randomUUID() };
}

function updateStartHeader() {
  const versionNode = document.querySelector(".brand-version");
  if (versionNode) versionNode.textContent = copyCatalog.brand.version;
  document.title = copyCatalog.brand.pageTitle;
}

function updateBrunchChatHeader() {
  const versionNode = document.querySelector(".brand-version");
  if (versionNode) versionNode.textContent = copyCatalog.brand.chatVersion;
  document.title = copyCatalog.brand.pageTitle;
}

function getBrunchChatInputRoots() {
  return [nodes.center.querySelector(".brunch-chat-narrow-user-input"), nodes.right].filter(Boolean);
}

function getBrunchChatInputRoot() {
  const roots = getBrunchChatInputRoots();
  return roots.find((root) => root.getClientRects?.().length > 0) ?? roots[0] ?? nodes.right;
}

function persistCurrentBrunchChat() {
  try {
    persistBrunchChatState(state.brunchChat);
    updateSaveStatusTimestamp();
  } catch (error) {
    state.brunchChat.error = error instanceof Error ? error.message : copyCatalog.brunchChat.error;
  }
}

function updateSaveStatusTimestamp(date = new Date()) {
  const timeNode = document.querySelector(".save-status-time");
  if (!timeNode) return;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  timeNode.textContent = `${hours}:${minutes}`;
  timeNode.dateTime = date.toISOString();
}

function brunchChatErrorMessage(error, fallback = copyCatalog.brunchChat.error) {
  if (error?.code === "network_unavailable") return copyCatalog.brunchChat.networkError;
  if (error?.code === "timeout") return copyCatalog.brunchChat.timeout;
  return error instanceof Error ? error.message : fallback;
}

function recordBrunchWritingDebug(event = {}) {
  if (state.brunchChat?.debugTraceEnabled !== true) return;
  const entry = {
    ...event,
    sessionId: state.brunchChat.sessionId,
    observedAt: new Date().toISOString()
  };
  const events = Array.isArray(globalThis.__OZ_BRUNCH_DEBUG_EVENTS__)
    ? globalThis.__OZ_BRUNCH_DEBUG_EVENTS__
    : [];
  events.push(entry);
  globalThis.__OZ_BRUNCH_DEBUG_EVENTS__ = events.slice(-200);
  if (typeof globalThis.CustomEvent === "function") {
    globalThis.dispatchEvent?.(new globalThis.CustomEvent("oz-brunch-debug-trace", { detail: entry }));
  }
}

async function loadBrunchChatCapabilities() {
  if (state.mode !== "brunch-chat") return;
  try {
    const payload = await codexProvider.getBrunchChatCapabilities();
    state.brunchChat.debugTraceEnabled = payload.debugTraceEnabled === true;
    const capabilities = Array.isArray(payload.models) ? payload.models.filter((entry) => entry && typeof entry.preset === "string") : [];
    state.brunchChat.modelCapabilities = capabilities;
    const visibleEfforts = new Set(["medium", "high", "xhigh", "max"]);
    const visibleCapabilities = capabilities.filter((entry) => visibleEfforts.has(String(entry.reasoningEffort).toLowerCase()));
    const selected = visibleCapabilities.find((entry) => entry.preset === state.brunchChat.modelPreset);
    if (!selected) {
      const defaultPreset = typeof payload.defaultPreset === "string" && visibleCapabilities.some((entry) => entry.preset === payload.defaultPreset)
        ? payload.defaultPreset
        : visibleCapabilities.find((entry) => entry.preset === BRUNCH_CHAT_DEFAULT_MODEL_PRESET)?.preset ?? visibleCapabilities[0]?.preset;
      if (defaultPreset) state.brunchChat.modelPreset = defaultPreset;
      persistCurrentBrunchChat();
    }
    renderApp();
  } catch {
    state.brunchChat.modelCapabilities = [];
    renderApp();
  }
}

async function loadBrunchWritingSkills() {
  if (state.mode !== "brunch-chat") return [];
  if (brunchWritingSkillsPromise) return brunchWritingSkillsPromise;
  brunchWritingSkillsPromise = (async () => {
    try {
      const payload = await codexProvider.getBrunchWritingSkills();
      state.brunchChat.writingSkills = Array.isArray(payload.skills)
        ? payload.skills.filter((skill) => skill && typeof skill.id === "string" && typeof skill.label === "string")
        : [];
      return state.brunchChat.writingSkills;
    } catch {
      state.brunchChat.writingSkills = [];
      return [];
    } finally {
      brunchWritingSkillsPromise = null;
    }
  })();
  return brunchWritingSkillsPromise;
}

function resetBrunchChat() {
  const previousCapabilities = state.brunchChat?.modelCapabilities ?? [];
  const previousWritingSkills = state.brunchChat?.writingSkills ?? [];
  generationAbortController?.abort();
  generationAbortController = null;
  clearGenerationTimer();
  brunchChatPendingMessages = null;
  state.mode = "brunch-chat";
  state.brunchChat = createBrunchChatState();
  state.brunchChat.modelCapabilities = previousCapabilities;
  state.brunchChat.writingSkills = previousWritingSkills;
  state.generatingElapsedSeconds = 0;
  brunchChatScrollMode = "initial";
  brunchChatScrollAnchorKey = "";
  brunchChatHistoryScrollMode = "initial";
  clearUrlSession();
  brunchChatStorageRestoreError = null;
  persistCurrentBrunchChat();
  updateBrunchChatHeader();
  renderApp();
  void loadBrunchChatCapabilities();
  void loadBrunchWritingSkills();
  requestAnimationFrame(() => getBrunchChatInputRoot().querySelector(".brunch-chat-chatbox textarea, .brunch-chat-composer textarea")?.focus());
}

function handleBrunchChatChoice(index) {
  if (state.mode !== "brunch-chat" || state.brunchChat.isLoading) return;
  state.brunchChat.selectedChoiceIndex = Number.isInteger(index) ? index : -1;
  state.brunchChat.error = null;
}

function handleBrunchChatDraft(value, { composing = false } = {}) {
  if (state.mode !== "brunch-chat") return;
  state.brunchChat.draft = String(value ?? "");
  state.brunchChat.selectedChoiceIndex = -1;
  state.brunchChat.error = null;
  syncBrunchChatDraftUi(state.brunchChat, getBrunchChatInputRoots(), { composing });
}

async function continueBrunchChat() {
  const chat = state.brunchChat;
  if (state.mode !== "brunch-chat") return;
  if (chat.isLoading) {
    await steerBrunchChat();
    return;
  }
  const latestAssistant = [...chat.messages].reverse().find((turn) => turn.role === "assistant");
  const choices = latestAssistant?.content?.choices ?? (chat.messages.length ? [] : brunchChatWelcome().choices);
  const draftMessage = String(chat.draft ?? "").trim();
  const selectedChoiceIndex = chat.selectedChoiceIndex;
  const message = chooseBrunchChatMessage({ draft: draftMessage, selectedChoice: choices[selectedChoiceIndex] });
  if (!message) {
    chat.error = copyCatalog.brunchChat.emptyMessage;
    renderApp();
    return;
  }

  const previousMessages = chat.messages;
  brunchChatPendingMessages = previousMessages;
  chat.messages = [...previousMessages, { role: "user", content: message }];
  brunchChatScrollAnchorKey = `chat-user-${chat.messages.length - 1}`;
  chat.draft = "";
  chat.selectedChoiceIndex = -1;
  chat.isLoading = true;
  chat.generationState = "abort";
  chat.error = null;
  chat.generationActivity = "request_received";
  chat.generationId = globalThis.crypto?.randomUUID?.() ?? `generation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  state.generatingElapsedSeconds = 0;
  brunchChatScrollMode = "latest-user";
  brunchChatHistoryScrollMode = "latest";
  const requestController = new AbortController();
  generationAbortController = requestController;
  let responseCommitted = false;
  startGenerationTimer();
  renderApp();
  const interaction = draftMessage
    ? { type: "free_text" }
    : {
      type: "choice",
      choiceIndex: selectedChoiceIndex,
      ...(latestAssistant && chat.messageMeta?.[String(chat.messages.length - 2)]?.turnId
        ? { sourceTurnId: chat.messageMeta[String(chat.messages.length - 2)].turnId }
        : {}),
      ...(selectedChoiceIndex === choices.length - 1 && choices[selectedChoiceIndex]?.label === copyCatalog.brunchChat.topicRetry ? { action: "retry_topics" } : {})
    };
  try {
    const response = await codexProvider.respondBrunchChat({ sessionId: chat.sessionId, message, generationId: chat.generationId, modelPreset: chat.modelPreset, interaction }, {
      signal: requestController.signal,
      onStatus: (status) => {
        if (status?.activity && state.brunchChat?.generationId === chat.generationId) updatePendingActivityText(status.activity);
      }
    });
    if (response.generationId) chat.generationId = response.generationId;
    if (response.runtimeProfile) chat.runtimeProfile = response.runtimeProfile;
    if (response.editorialPhaseAfter || response.editorialPhase) chat.editorialPhase = response.editorialPhaseAfter ?? response.editorialPhase;
    const assistantIndex = chat.messages.length;
    chat.messages = [...chat.messages, { role: "assistant", content: response }];
    responseCommitted = true;
    chat.messageMeta = { ...(chat.messageMeta ?? {}), [String(assistantIndex)]: { turnId: response.turnId ?? null, versionId: response.versionId ?? null, branchId: response.branchId ?? null, versionSummaries: response.versionSummaries ?? [] } };
    chat.selectedChoiceIndex = defaultBrunchChatChoiceIndex(chat.messages);
    persistCurrentBrunchChat();
    void evaluateBrunchChatReadiness(assistantIndex);
  } catch (error) {
    chat.messages = brunchChatPendingMessages ?? previousMessages;
    if (!isBrunchChatRequestAborted(error, requestController.signal)) {
      chat.error = brunchChatErrorMessage(error);
    }
  } finally {
    if (responseCommitted) brunchChatScrollMode = "latest-user";
    chat.isLoading = false;
    chat.generationState = "resting";
    chat.generationId = null;
    brunchChatPendingMessages = null;
    generationAbortController = null;
    clearGenerationTimer();
    state.generatingElapsedSeconds = 0;
    renderApp();
  }
}

async function steerBrunchChat() {
  const chat = state.brunchChat;
  const message = String(chat.draft ?? "").trim();
  if (state.mode !== "brunch-chat" || !chat.isLoading || !message || !chat.generationId) return;
  const previousDraft = chat.draft;
  chat.draft = "";
  chat.messages = [...chat.messages, { role: "user", content: message }];
  brunchChatScrollAnchorKey = `chat-user-${chat.messages.length - 1}`;
  chat.error = null;
  brunchChatScrollMode = "latest-user";
  brunchChatHistoryScrollMode = "latest";
  syncBrunchChatDraftUi(chat, getBrunchChatInputRoots());
  renderApp();
  try {
    await codexProvider.steerBrunchChat({ sessionId: chat.sessionId, generationId: chat.generationId, message });
  } catch (error) {
    chat.messages = chat.messages.slice(0, -1);
    chat.draft = previousDraft;
    chat.error = error?.code === "network_unavailable"
      ? copyCatalog.brunchChat.networkError
      : error instanceof Error ? error.message : copyCatalog.brunchChat.error;
    renderApp();
  }
}

async function copyBrunchChatTurn(index) {
  const turn = state.brunchChat.messages?.[index];
  const markdown = turn?.role === "assistant"
    ? turn.content?.writing_preview?.markdown ?? turn.content?.markdown
    : "";
  if (typeof markdown !== "string" || !markdown) return;
  try {
    await navigator.clipboard.writeText(stripBrunchSourcesForCopy(markdown));
    const button = nodes.center.querySelector(`[data-copy-chat-turn="${String(index)}"]`);
    if (!button) return;
    const originalLabel = button.getAttribute("aria-label") ?? copyCatalog.brunchChat.copyResponse;
    button.setAttribute("aria-label", copyCatalog.brunchChat.copied);
    button.setAttribute("title", copyCatalog.brunchChat.copied);
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.setAttribute("aria-label", originalLabel);
      button.setAttribute("title", originalLabel);
    }, 1200);
  } catch {
    state.brunchChat.error = copyCatalog.brunchChat.error;
    renderApp();
  }
}

async function isCurrentBrunchReadinessTarget(index, targetMetadata, previewHash) {
  const currentTurn = state.brunchChat.messages?.[index];
  const currentMetadata = state.brunchChat.messageMeta?.[String(index)] ?? {};
  if (currentTurn?.role !== "assistant" || currentMetadata.turnId !== targetMetadata.turnId || currentMetadata.versionId !== targetMetadata.versionId) return false;
  const currentPreview = currentTurn.content?.writing_preview;
  if (!currentPreview || typeof currentPreview.markdown !== "string") return false;
  return await hashWritingEditorMarkdown(currentPreview.markdown) === previewHash;
}

async function evaluateBrunchChatReadiness(index, { force = false } = {}) {
  const chat = state.brunchChat;
  const turn = chat.messages?.[index];
  const metadata = chat.messageMeta?.[String(index)] ?? {};
  const preview = turn?.role === "assistant" ? turn.content?.writing_preview : null;
  if (state.mode !== "brunch-chat" || !preview || !metadata.turnId || !metadata.versionId) return null;
  const previewHash = await hashWritingEditorMarkdown(preview.markdown);
  const existing = metadata.readiness;
  if (!force && existing?.previewHash === previewHash && existing?.band) return existing;
  chat.messageMeta = {
    ...(chat.messageMeta ?? {}),
    [String(index)]: { ...metadata, readiness: { status: "evaluating", previewHash } }
  };
  persistCurrentBrunchChat();
  renderApp();
  try {
    const result = await codexProvider.evaluateBrunchChatReadiness({
      sessionId: chat.sessionId,
      turnId: metadata.turnId,
      versionId: metadata.versionId,
      previewHash
    });
    if (!await isCurrentBrunchReadinessTarget(index, metadata, previewHash)) return null;
    const readiness = { ...(result.readiness ?? {}), status: undefined };
    delete readiness.status;
    chat.messageMeta = {
      ...(chat.messageMeta ?? {}),
      [String(index)]: { ...(chat.messageMeta?.[String(index)] ?? metadata), readiness }
    };
    persistCurrentBrunchChat();
    renderApp();
    return readiness;
  } catch (error) {
    if (!await isCurrentBrunchReadinessTarget(index, metadata, previewHash)) return null;
    const readiness = {
      status: "failed",
      previewHash,
      summary: error?.code === "network_unavailable" ? copyCatalog.brunchChat.networkError : copyCatalog.brunchChat.readiness.failed
    };
    chat.messageMeta = {
      ...(chat.messageMeta ?? {}),
      [String(index)]: { ...(chat.messageMeta?.[String(index)] ?? metadata), readiness }
    };
    persistCurrentBrunchChat();
    renderApp();
    return null;
  }
}

function handleBrunchChatModelSelect(preset) {
  const chat = state.brunchChat;
  if (state.mode !== "brunch-chat" || chat.isLoading || typeof preset !== "string") return;
  const capability = chat.modelCapabilities?.find((entry) => entry.preset === preset);
  if (!capability || !["medium", "high", "xhigh", "max"].includes(String(capability.reasoningEffort).toLowerCase())) return;
  chat.modelPreset = preset;
  chat.error = null;
  persistCurrentBrunchChat();
  renderApp();
}

function createBrunchGenerationId() {
  return globalThis.crypto?.randomUUID?.() ?? `generation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function regenerateBrunchChatTurn(index) {
  const chat = state.brunchChat;
  const turn = chat.messages?.[index];
  const metadata = chat.messageMeta?.[String(index)] ?? {};
  if (state.mode !== "brunch-chat" || chat.isLoading || brunchChatVersionActionPending || turn?.role !== "assistant" || !metadata.turnId || !metadata.versionId) return;
  brunchChatVersionActionPending = true;
  chat.isLoading = true;
  chat.generationState = "abort";
  chat.generationId = createBrunchGenerationId();
  chat.error = null;
  const requestController = new AbortController();
  generationAbortController = requestController;
  state.generatingElapsedSeconds = 0;
  startGenerationTimer();
  renderApp();
  try {
    const response = await codexProvider.regenerateBrunchChat({
      sessionId: chat.sessionId,
      turnId: metadata.turnId,
      sourceVersionId: metadata.versionId,
      modelPreset: chat.modelPreset,
      generationId: chat.generationId
    }, { signal: requestController.signal });
    chat.messages = chat.messages.map((message, messageIndex) => messageIndex === index ? { role: "assistant", content: response } : message);
    chat.messageMeta = {
      ...(chat.messageMeta ?? {}),
      [String(index)]: {
        ...metadata,
        turnId: response.turnId ?? metadata.turnId,
        versionId: response.versionId ?? metadata.versionId,
        versionSummaries: response.versionSummaries ?? metadata.versionSummaries ?? []
      }
    };
    chat.selectedChoiceIndex = 0;
    persistCurrentBrunchChat();
    void evaluateBrunchChatReadiness(index);
  } catch (error) {
    if (!isBrunchChatRequestAborted(error, requestController.signal)) {
      chat.error = brunchChatErrorMessage(error);
    }
  } finally {
    chat.isLoading = false;
    chat.generationState = "resting";
    chat.generationId = null;
    generationAbortController = null;
    clearGenerationTimer();
    state.generatingElapsedSeconds = 0;
    brunchChatVersionActionPending = false;
    renderApp();
  }
}

async function activateBrunchChatVersion(index, versionId) {
  const chat = state.brunchChat;
  const metadata = chat.messageMeta?.[String(index)] ?? {};
  if (state.mode !== "brunch-chat" || chat.isLoading || brunchChatVersionActionPending || !metadata.turnId || typeof versionId !== "string") return;
  brunchChatVersionActionPending = true;
  chat.error = null;
  try {
    const result = await codexProvider.activateBrunchChatVersion({ sessionId: chat.sessionId, turnId: metadata.turnId, versionId });
    if (!result.response) throw new Error(copyCatalog.brunchChat.actionFailed);
    chat.messages = chat.messages.map((message, messageIndex) => messageIndex === index ? { role: "assistant", content: result.response } : message);
    chat.messageMeta = { ...(chat.messageMeta ?? {}), [String(index)]: { ...metadata, versionId: result.versionId ?? versionId, branchId: result.branchId ?? metadata.branchId, versionSummaries: result.versionSummaries ?? metadata.versionSummaries ?? [] } };
    chat.selectedChoiceIndex = 0;
    persistCurrentBrunchChat();
    const selectedSummary = (result.versionSummaries ?? []).find((entry) => entry.versionId === (result.versionId ?? versionId));
    if (selectedSummary?.writingReadiness) {
      chat.messageMeta = { ...(chat.messageMeta ?? {}), [String(index)]: { ...(chat.messageMeta?.[String(index)] ?? metadata), readiness: selectedSummary.writingReadiness } };
      persistCurrentBrunchChat();
    }
  } catch (error) {
    chat.error = brunchChatErrorMessage(error, copyCatalog.brunchChat.actionFailed);
  } finally {
    brunchChatVersionActionPending = false;
    renderApp();
  }
}

async function restoreBrunchChatVersion(index, versionId) {
  const chat = state.brunchChat;
  const metadata = chat.messageMeta?.[String(index)] ?? {};
  if (state.mode !== "brunch-chat" || chat.isLoading || brunchChatVersionActionPending || !isCuratedBrunchChatProfile(chat.runtimeProfile) || !metadata.turnId || typeof versionId !== "string") return;
  brunchChatVersionActionPending = true;
  chat.error = null;
  try {
    const result = await codexProvider.restoreBrunchChatVersion({ sessionId: chat.sessionId, turnId: metadata.turnId, versionId });
    if (!Array.isArray(result.messages)) throw new Error(copyCatalog.brunchChat.actionFailed);
    chat.messages = normalizeBrunchChatMessages(result.messages);
    chat.messageMeta = result.messageMeta && typeof result.messageMeta === "object" ? result.messageMeta : {};
    if (result.editorialPhase) chat.editorialPhase = result.editorialPhase;
    if (result.runtimeProfile) chat.runtimeProfile = result.runtimeProfile;
    chat.selectedChoiceIndex = defaultBrunchChatChoiceIndex(chat.messages);
    persistCurrentBrunchChat();
    brunchChatHistoryScrollMode = "latest";
    brunchChatScrollMode = "latest-assistant";
  } catch (error) {
    chat.error = brunchChatErrorMessage(error, copyCatalog.brunchChat.actionFailed);
  } finally {
    brunchChatVersionActionPending = false;
    renderApp();
  }
}

async function branchBrunchChatTurn(index) {
  const chat = state.brunchChat;
  const metadata = chat.messageMeta?.[String(index)] ?? {};
  if (state.mode !== "brunch-chat" || chat.isLoading || brunchChatVersionActionPending || !metadata.turnId || !metadata.versionId) return;
  brunchChatVersionActionPending = true;
  chat.error = null;
  try {
    const result = await codexProvider.branchBrunchChat({ sessionId: chat.sessionId, turnId: metadata.turnId, versionId: metadata.versionId });
    chat.messages = normalizeBrunchChatMessages(result.messages);
    const nextMeta = Object.fromEntries(Object.entries(chat.messageMeta ?? {}).filter(([key]) => Number(key) < chat.messages.length));
    const assistantMessage = chat.messages[index]?.role === "assistant" ? index : -1;
    if (assistantMessage >= 0) nextMeta[String(assistantMessage)] = { ...(nextMeta[String(assistantMessage)] ?? metadata), branchId: result.branchId ?? metadata.branchId, versionId: result.versionId ?? metadata.versionId, versionSummaries: result.versionSummaries ?? metadata.versionSummaries ?? [] };
    chat.messageMeta = nextMeta;
    chat.selectedChoiceIndex = 0;
    persistCurrentBrunchChat();
  } catch (error) {
    chat.error = brunchChatErrorMessage(error, copyCatalog.brunchChat.actionFailed);
  } finally {
    brunchChatVersionActionPending = false;
    renderApp();
  }
}

function normalizeLines(value) {
  return String(value ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function parseV06StartScope(formData) {
  const draft = Object.fromEntries(formData.entries());
  const seedUrls = normalizeLines(draft.seed_urls);
  const comparisonHints = normalizeLines(draft.comparison_hints);
  const errors = {};
  const subject = String(draft.subject ?? "").trim();
  if (!subject || subject.length > 300) errors.subject = "대상을 1~300자로 입력해 주세요.";
  if (seedUrls.length > 10 || seedUrls.some((value) => {
    try { const url = new URL(value); return !["http:", "https:"].includes(url.protocol); } catch { return true; }
  })) errors.seed_urls = "시작 자료 URL 형식을 확인해 주세요.";
  if (comparisonHints.length > 10 || comparisonHints.some((value) => value.length > 200)) errors.comparison_hints = "비교 힌트를 10개 이하, 항목당 200자 이하로 입력해 주세요.";
  for (const key of ["initial_interest", "editor_notes"]) {
    if (String(draft[key] ?? "").trim().length > 1000) errors[key] = "1,000자 이하로 입력해 주세요.";
  }
  const counts = ["source_count_min", "source_count_preferred", "source_count_max"].map((key) => Number(draft[key]));
  if (!counts.every((value) => Number.isInteger(value) && value >= 1 && value <= 100) || counts[0] > counts[1] || counts[1] > counts[2]) errors.target_source_count = "목표 자료 수를 최소·권장·최대 순서의 1~100 정수로 입력해 주세요.";
  const researchDepth = String(draft.research_depth ?? "");
  if (!["light", "standard", "deep"].includes(researchDepth)) errors.research_depth = "조사 깊이를 선택해 주세요.";
  const scope = {
    subject,
    seed_urls: [...new Set(seedUrls)],
    research_depth: researchDepth,
    target_source_count: { min: counts[0], preferred: counts[1], max: counts[2] },
    ...(String(draft.initial_interest ?? "").trim() ? { initial_interest: String(draft.initial_interest).trim() } : {}),
    ...(comparisonHints.length ? { comparison_hints: [...new Set(comparisonHints)] } : {}),
    ...(String(draft.editor_notes ?? "").trim() ? { editor_notes: String(draft.editor_notes).trim() } : {})
  };
  return { draft, scope, errors };
}

async function submitV06Start(formData) {
  const start = state.v06.start;
  if (!start || start.status === "loading") return;
  const { draft, scope, errors } = parseV06StartScope(formData);
  start.draft = draft;
  start.errors = errors;
  start.message = "";
  if (Object.keys(errors).length) {
    start.status = "error";
    renderApp();
    nodes.center.querySelector("[aria-describedby]")?.focus();
    return;
  }
  start.status = "loading";
  renderApp();
  try {
    const payload = await codexProvider.createV06Session({ ...scope, request_id: start.requestId });
    const operator = payload.operator ?? await codexProvider.loadV06Operator(payload.session?.workflow_session_id ?? payload.session?.id);
    const sessionId = payload.session?.workflow_session_id ?? payload.session?.id ?? operator?.session?.workflow_session_id;
    if (!operator || !sessionId) throw new Error("새 작업 세션 정보를 확인하지 못했습니다.");
    state.mode = "v06";
    state.v06.sessionId = sessionId;
    state.v06.operator = operator;
    state.v06.activeRuns = operator.active_runs ?? [];
    state.v06.selectedStep = operator.runtime_view?.current_user_step ?? "research_review";
    state.v06.start = null;
    setUrlSession(sessionId);
    renderApp();
    const heading = nodes.center.querySelector("h1");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus?.();
  } catch (error) {
    start.status = "error";
    start.message = error instanceof Error ? error.message : "새 글을 시작하지 못했습니다.";
    start.errors = error?.field_errors ?? start.errors;
    renderApp();
  }
}

async function loadWorkflowSession(sessionId, options = {}) {
  clearGenerationTimer();
  stopResearchJobPolling();
  stopV06RunPolling();

  try {
    try {
      const operator = await codexProvider.loadV06Operator(sessionId);
      if (operator?.session?.runtime_version === "0.6" && operator?.session?.workflow_profile === "brunch_research_editorial_v1") {
        state.mode = "v06";
        state.v06.sessionId = sessionId;
        state.v06.operator = operator;
        state.v06.activeRuns = operator.active_runs ?? [];
        state.v06.selectedStep = operator.runtime_view.current_user_step ?? "research_review";
        state.v06.selectedFindingId = null;
        state.v06.selectedClaimId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        state.v06.detailTrigger = null;
        state.v06.editing = null;
        state.v06.notice = null;
        renderApp();
        if (state.v06.activeRuns.length > 0) startV06RunPolling();
        return;
      }
    } catch {}
    state.mode = "legacy";
    const versionNode = document.querySelector(".brand-version");
    if (versionNode) versionNode.textContent = copyCatalog.brand.version;
    document.title = copyCatalog.brand.pageTitle;
    state.timeline = await codexProvider.loadTimeline({ workflowSessionId: sessionId });
    state.conversationTurns = conversationTurnsFromTimeline(state.timeline);
    state.isGenerating = false;
    state.generatingElapsedSeconds = 0;
    state.pendingTurn = null;
    state.lastFailedRequestSignature = null;
    state.workflowCompleted = state.timeline.viewModel.step === "publish_package_review";
    state.selectionRevealPending = false;
    state.rightRevealPending = false;
    state.researchRequestPending = false;
    state.sourceSelectionSavePending = false;
    state.shouldScrollConversation = true;
    state.conversationScrollTarget = null;
    const warnings = state.timeline.sessionWarnings ?? [];
    if (state.timeline.readOnly) {
      setWorkflowNotice("warning", `읽기 전용 세션입니다. ${warnings.length ? `경고 ${warnings.length}건을 확인하세요.` : "이벤트와 artifact를 열람할 수 있습니다."}`);
    } else if (warnings.length) {
      setWorkflowNotice("warning", `세션을 복원했습니다. 경고 ${warnings.length}건이 있습니다.`);
    } else {
      clearWorkflowNotice();
    }

    if (options.updateUrl !== false) {
      setUrlSession(sessionId);
    }

    renderApp();
    const claimResearchRequest = state.timeline.viewModel.raw?.state_patch?.metadata?.claim_research_request
      ?? state.timeline.viewModel.raw?.ui?.draft?.metadata?.claim_research_request;
    if (claimResearchRequest?.job_id && ["pending", "running", "research_running"].includes(claimResearchRequest.status)) {
      startClaimResearchPolling(claimResearchRequest.job_id);
    }
  } catch (error) {
    state.isGenerating = false;
    state.pendingTurn = null;
    setWorkflowNotice("error", `세션 복원 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    renderApp();
  }
}

async function loadV06OperatorSession(sessionId, options = {}) {
  const operator = await codexProvider.loadV06Operator(sessionId);
  state.mode = "v06";
  state.v06.sessionId = sessionId;
  state.v06.operator = operator;
  state.v06.selectedStep = state.v06.selectedStep && operator.steps.some((step) => step.id === state.v06.selectedStep)
    ? state.v06.selectedStep
    : operator.runtime_view.current_user_step ?? "research_review";
  state.v06.selectedFindingId = null;
  state.v06.selectedClaimId = null;
  state.v06.selectedNoteId = null;
  state.v06.selectedSourceId = null;
  state.v06.selectedDirectionId = null;
  state.v06.detailModal = null;
  state.v06.detailTrigger = null;
  state.v06.editing = null;
  state.v06.busy = false;
  state.v06.notice = null;
  if (options.updateUrl !== false) setUrlSession(sessionId);
  const versionNode = document.querySelector(".brand-version");
  if (versionNode) versionNode.textContent = copyCatalog.brand.version;
  document.title = copyCatalog.brand.pageTitle;
  renderApp();
  if (state.v06.activeRuns.length > 0) startV06RunPolling();
}

function ensureV06ContextSelection(operator, step) {
  if (step === "research_review" && !state.v06.selectedSourceId) {
    state.v06.selectedSourceId = operator.research?.entries?.[0]?.source_ref ?? null;
  }
  if (step === "synthesis_review" && !state.v06.selectedFindingId) {
    state.v06.selectedFindingId = operator.synthesis?.findings?.[0]?.finding_id ?? null;
  }
  if (step === "argument_review" && !state.v06.selectedClaimId) {
    state.v06.selectedClaimId = operator.argument?.claims?.[0]?.claim_id ?? null;
  }
}

async function openWorkflowSession(sessionId) {
  await loadWorkflowSession(sessionId);
}

async function openBrunchChatSession(sessionId) {
  const capabilities = state.brunchChat?.modelCapabilities ?? [];
  const writingSkills = state.brunchChat?.writingSkills ?? [];
  const payload = await codexProvider.loadBrunchChatSession(sessionId);
  state.mode = "brunch-chat";
  state.brunchChat = createBrunchChatState({
    sessionId: payload.sessionId ?? sessionId,
    messages: payload.messages,
    messageMeta: payload.messageMeta,
    modelPreset: payload.modelPreset,
    runtimeProfile: payload.runtimeProfile,
    editorialPhase: payload.editorialPhase
  });
  state.brunchChat.modelCapabilities = capabilities;
  state.brunchChat.writingSkills = writingSkills;
  state.generatingElapsedSeconds = 0;
  brunchChatScrollMode = "initial";
  brunchChatHistoryScrollMode = "initial";
  brunchChatStorageRestoreError = null;
  clearUrlSession();
  persistCurrentBrunchChat();
  updateBrunchChatHeader();
  renderApp();
}

async function openFixtureSample() {
  clearUrlSession();
  stopResearchJobPolling();
  stopV06RunPolling();
  state.mode = "legacy";
  state.v06.start = null;
  const versionNode = document.querySelector(".brand-version");
  if (versionNode) versionNode.textContent = copyCatalog.brand.version;
  document.title = copyCatalog.brand.pageTitle;
  state.timeline = await fixtureProvider.loadTimeline({
    workflowSessionId: createWorkflowSessionId("fixture")
  });
  state.conversationTurns = conversationTurnsFromTimeline(state.timeline);
  state.pendingTurn = null;
  state.lastFailedRequestSignature = null;
  state.workflowCompleted = false;
  state.selectionRevealPending = false;
  state.rightRevealPending = false;
  state.researchRequestPending = false;
  state.sourceSelectionSavePending = false;
  state.shouldScrollConversation = true;
  state.conversationScrollTarget = null;
  clearWorkflowNotice();
  renderApp();
}

function createNewWorkflow() {
  if (state.mode === "brunch-chat") {
    resetBrunchChat();
    return;
  }
  clearUrlSession();
  clearGenerationTimer();
  stopResearchJobPolling();
  stopV06RunPolling();
  state.v06.start = createV06StartState();
  state.isGenerating = false;
  state.generatingElapsedSeconds = 0;
  state.pendingTurn = null;
  state.lastFailedRequestSignature = null;
  state.workflowCompleted = false;
  state.selectionRevealPending = false;
  state.rightRevealPending = false;
  state.researchRequestPending = false;
  state.sourceSelectionSavePending = false;
  state.shouldScrollConversation = false;
  state.conversationScrollTarget = null;
  clearWorkflowNotice();
  state.mode = "v06-start";
  state.v06.operator = null;
  state.v06.sessionId = null;
  state.v06.editing = null;
  updateStartHeader();
  renderApp();
}

async function refreshV06Operator() {
  if (state.mode !== "v06" || !state.v06.sessionId) return;
  state.v06.operator = await codexProvider.loadV06Operator(state.v06.sessionId);
  state.v06.activeRuns = state.v06.operator.active_runs ?? [];
  renderApp();
  if (state.v06.activeRuns.length > 0) startV06RunPolling();
}

function stopV06RunPolling() {
  if (v06RunPollingTimer) window.clearInterval(v06RunPollingTimer);
  v06RunPollingTimer = null;
}

function startV06RunPolling() {
  stopV06RunPolling();
  v06RunPollingTimer = window.setInterval(async () => {
    if (state.mode !== "v06" || !state.v06.sessionId) return stopV06RunPolling();
    try {
      const [operator, result] = await Promise.all([
        codexProvider.loadV06Operator(state.v06.sessionId),
        codexProvider.loadV06OperatorRuns(state.v06.sessionId)
      ]);
      state.v06.operator = operator;
      state.v06.activeRuns = operator.active_runs ?? result.active_runs ?? [];
      if (state.v06.activeRuns.length === 0 && !state.v06.busy) {
        const nextStep = operator.runtime_view?.current_user_step;
        if (nextStep && operator.steps.some((step) => step.id === nextStep)) state.v06.selectedStep = nextStep;
        stopV06RunPolling();
      }
      renderApp();
    } catch {
      state.v06.notice = V06_OPERATOR_COPY.research.runningRefreshError;
      renderApp();
    }
  }, 1200);
}

async function handleV06OperatorAction(input) {
  if (state.mode !== "v06" || !state.v06.sessionId || state.v06.busy) return;
  if (input.action === "approve" && state.v06.selectedStep === "research_review" && state.v06.operator?.research?.editorial_readiness && state.v06.operator.research.editorial_readiness !== "ready") {
    input = {
      ...input,
      approval_metadata: {
        approval_scope: "restricted",
        approved_with_gaps: true,
        approved_editorial_scope: "AI 시대, 디자인 포트폴리오에서 결과물뿐 아니라 과정과 판단을 어떻게 보여줘야 할까?",
        acknowledged_missing_lanes: ["historical", "seniority"],
        prohibited_generalizations: [
          "AI로 인해 디자인 채용 전반의 평가 기준이 바뀌었다고 일반화",
          "모든 채용 담당자가 폐기안을 중요하게 평가한다고 단정",
          "AI 이전과 이후의 평가 기준이 명확히 달라졌다고 단정",
          "주니어와 시니어의 평가 기준 차이를 현재 자료로 설명"
        ]
      }
    };
  }
  if (input.action === "revise" && ["editorial_direction_review", "argument_review"].includes(state.v06.selectedStep)) {
    const confirmed = window.confirm("이 수정으로 다음 결과가 다시 생성될 수 있습니다. 변경사항을 저장할까요?");
    if (!confirmed) return;
  }
  state.v06.busy = true;
  state.v06.notice = null;
  startV06RunPolling();
  renderApp();
  try {
    const payload = await codexProvider.runV06OperatorAction(state.v06.sessionId, input);
    state.v06.operator = payload.operator ?? await codexProvider.loadV06Operator(state.v06.sessionId);
    const nextStep = state.v06.operator.runtime_view?.current_user_step;
    if (nextStep && state.v06.operator.steps.some((step) => step.id === nextStep)) state.v06.selectedStep = nextStep;
    state.v06.editing = null;
    state.v06.notice = ["failed", "blocked"].includes(state.v06.operator.runtime_view?.execution_state) ? null : "저장되었습니다.";
  } catch (error) {
    state.v06.notice = error instanceof Error ? error.message : "작업을 완료하지 못했습니다.";
  } finally {
    state.v06.busy = false;
    if (state.v06.activeRuns.length === 0) stopV06RunPolling();
    renderApp();
  }
}

const drawers = createDrawerController({
  nodes,
  state,
  getSelectedResponse: () => currentViewModel().raw,
  onNewWorkflow: createNewWorkflow,
  onOpenFixtureSample: openFixtureSample,
  listWorkflowSessions: (options) => codexProvider.listWorkflowSessions(options),
  onOpenWorkflowSession: openWorkflowSession,
  listBrunchChatSessions: (options) => codexProvider.listBrunchChatSessions(options),
  onOpenBrunchSession: openBrunchChatSession
});

const providerStatus = createProviderStatusController(nodes, codexProvider);

function stopResearchJobPolling() {
  researchJobPoller?.stop();
  researchJobPoller = null;
  researchPollPromise = null;
  claimResearchJobPoller?.stop();
  claimResearchJobPoller = null;
  claimResearchPollPromise = null;
}

function replaceCurrentSourceSelection(selection, options = {}) {
  const index = state.timeline.selectedIndex;
  const current = state.timeline.responses[index];
  if (!current || current.step !== "source_selection") return;
  const response = {
    ...current,
    ui: { ...(current.ui ?? {}), source_selection: selection },
    state_patch: {
      ...(current.state_patch ?? {}),
      selected_document_ids: selection.selected_document_ids ?? [],
      selected_evidence_ids: selection.selected_evidence_ids ?? [],
      selected_research_source_ids: selection.selected_research_source_ids ?? [],
      source_selection: selection,
      metadata: { ...(current.state_patch?.metadata ?? {}), source_selection_context: selection }
    }
  };
  state.timeline = selectTimelineIndex({ ...state.timeline, responses: state.timeline.responses.map((item, itemIndex) => itemIndex === index ? response : item) }, index);
  panels.updateSourceSelection(currentViewModel(), { scope: options.scope ?? "all" });
}

function setSourceSelectionContinueEnabled(enabled) {
  if (currentViewModel().step !== "source_selection") return;
  const button = nodes.center.querySelector(".continue-button");
  if (button) button.disabled = !enabled || state.isGenerating;
}

function selectedSourceIdsWithHiddenPreserved(current = {}) {
  const projected = applySourceSelectionProjection(current);
  return {
    selected_document_ids: projected.selected_document_ids,
    selected_evidence_ids: projected.selected_evidence_ids,
    selected_research_source_ids: projected.selected_research_source_ids ?? []
  };
}

function compactKnowledgeSearchItem(item) {
  return {
    document_id: item.document_id ?? item.id,
    title: item.title,
    source_kind: item.source_kind,
    target_channel: item.target_channel,
    content_maturity: item.content_maturity,
    content_roles: item.content_roles ?? [],
    review_status: item.review_status,
    excerpt: String(item.excerpt ?? item.chunk_content ?? item.content ?? "").slice(0, 1200),
    source_path: item.source_path,
    metadata: item.metadata ?? {}
  };
}

function compactSelectedEvidence(item) {
  return {
    evidence_id: item.evidence_id ?? item.id,
    claim: item.claim,
    excerpt: String(item.excerpt ?? "").slice(0, 2000),
    source_id: item.source_id,
    source_title: item.source_title,
    publisher: item.publisher,
    canonical_url: item.canonical_url,
    locator: item.locator ?? {},
    snapshot_id: item.snapshot_id,
    fetched_at: item.fetched_at,
    source_published_at: item.source_published_at ?? null,
    valid_until: item.valid_until ?? null,
    evidence_status: item.evidence_status,
    source_review_status: item.source_review_status,
    fetch_status: item.fetch_status
  };
}

function mergeSelectedSourceRecords(current, nextDocuments, nextEvidence, selectedDocumentIds, selectedEvidenceIds, selectedResearchSourceIds = []) {
  const documentIds = new Set(selectedDocumentIds);
  const evidenceIds = new Set(selectedEvidenceIds);
  const researchSourceIds = new Set(selectedResearchSourceIds);
  const unique = (items, key) => {
    const seen = new Set();
    return items.filter((item) => {
      const id = item?.[key];
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  return {
    selected_documents: unique([
      ...(current.selected_documents ?? []),
      ...(current.knowledge_documents ?? []).filter((item) => documentIds.has(item.document_id ?? item.id)),
      ...nextDocuments.filter((item) => documentIds.has(item.document_id ?? item.id))
    ], "document_id"),
    selected_evidence: unique([
      ...(current.selected_evidence ?? []),
      ...(current.research_evidence ?? []).filter((item) => evidenceIds.has(item.evidence_id ?? item.id)),
      ...nextEvidence.filter((item) => evidenceIds.has(item.evidence_id ?? item.id))
    ], "evidence_id"),
    selected_research_sources: unique([
      ...(current.selected_research_sources ?? []),
      ...(current.research_sources ?? []).filter((item) => researchSourceIds.has(item.source_id ?? item.id))
    ], "source_id")
  };
}

function compactSourceSelectionForProvider(selection = {}) {
  const projected = buildSourceSelectionProjection(selection);
  const selectedDocumentIds = new Set(projected.effective_selected.document_ids);
  const selectedEvidenceIds = new Set(projected.effective_selected.evidence_ids);
  const documents = (selection.selected_documents ?? selection.knowledge_documents ?? [])
    .filter((item) => selectedDocumentIds.has(item.document_id ?? item.id))
    .map(compactKnowledgeSearchItem);
  const evidenceCandidates = selection.selected_evidence ?? selection.research_evidence ?? [];
  const evidence = evidenceCandidates
    .filter((item) => selectedEvidenceIds.has(item.evidence_id ?? item.id) && isResearchEvidenceSelectable(item))
    .map(compactSelectedEvidence);
  const safeEvidenceIds = new Set(evidence.map((item) => item.evidence_id));
  return {
    status: selection.status,
    query: selection.query,
    selected_document_ids: [...selectedDocumentIds],
    selected_evidence_ids: [...safeEvidenceIds],
    selected_research_source_ids: [...new Set(selection.selected_research_source_ids ?? [])],
    knowledge_documents: documents,
    research_evidence: evidence,
    recommended_documents: [],
    recommended_evidence: []
  };
}

async function searchSourceSelection(input = {}) {
  const current = currentViewModel().ui.source_selection ?? {};
  const selectedSelection = selectedSourceIdsWithHiddenPreserved(current);
  const selectedDocumentIds = selectedSelection.selected_document_ids;
  const selectedEvidenceIds = selectedSelection.selected_evidence_ids;
  const query = input.query ?? current.query ?? "";
  const status = input.status ?? current.status_filter ?? "all";
  const filters = { ...(current.filters ?? {}), ...(input.filters ?? {}) };
  const searchSequence = (state.sourceSearchSequence ?? 0) + 1;
  state.sourceSearchSequence = searchSequence;
  replaceCurrentSourceSelection({
    ...current,
    query,
    status: "searching",
    search_state: "searching",
    status_filter: status,
    filters,
    selected_document_ids: selectedDocumentIds,
    selected_evidence_ids: selectedEvidenceIds,
    selected_research_source_ids: selectedSelection.selected_research_source_ids,
    error_message: ""
  }, { scope: "search" });
  const track = state.timeline.accumulated.target_track ?? state.timeline.accumulated.track;
  const targetChannel = track === "official_inblog" ? "inblog" : track === "brunch" ? "brunch" : state.timeline.accumulated.target_channel;
  try {
    const includePendingResearch = input.includePendingResearch === true && status !== "pending";
    const searchResults = await Promise.all([
      codexProvider.searchKnowledge({ query, target_channel: targetChannel, allow_empty: true, allow_unscoped: false, limit: 100 }),
      codexProvider.searchResearch({ query, status, include_expired: status === "all", include_sources: true, limit: 100 }),
      ...(includePendingResearch ? [codexProvider.searchResearch({ query, status: "pending", include_expired: false, include_sources: false, limit: 100 })] : [])
    ]);
    if (state.sourceSearchSequence !== searchSequence) return;
    const latest = currentViewModel().ui.source_selection ?? {};
    const latestSelected = selectedSourceIdsWithHiddenPreserved(latest);
    const knowledgeResult = searchResults[0];
    const researchResult = searchResults[1];
    const knowledgeDocuments = (knowledgeResult.results ?? []).map(compactKnowledgeSearchItem);
    const researchEvidence = researchResult.results ?? [];
    const researchSources = researchResult.sources ?? [];
    const pendingResearchEvidence = searchResults[2]?.results ?? [];
    const merged = {
      ...latest,
      knowledge_documents: knowledgeDocuments,
      research_evidence: [...researchEvidence, ...pendingResearchEvidence],
      research_sources: researchSources,
      research_pending_results: pendingResearchEvidence
    };
  const selectedRecords = mergeSelectedSourceRecords(latest, merged.knowledge_documents, merged.research_evidence, latestSelected.selected_document_ids, latestSelected.selected_evidence_ids, latestSelected.selected_research_source_ids);
    replaceCurrentSourceSelection({
      ...merged,
      query: latest.query ?? query,
      status: "results_ready",
      search_state: merged.knowledge_documents.length || merged.research_evidence.length || merged.research_sources.length ? "results_ready" : "empty",
      status_filter: status,
      filters,
      selected_document_ids: latestSelected.selected_document_ids,
      selected_evidence_ids: latestSelected.selected_evidence_ids,
      selected_research_source_ids: latestSelected.selected_research_source_ids,
      visible_result_limit: 10,
      recommended_documents: knowledgeDocuments,
      recommended_evidence: researchEvidence,
      ...selectedRecords,
      warnings: []
    }, { scope: "search" });
    clearWorkflowNotice();
  } catch (error) {
    if (state.sourceSearchSequence !== searchSequence) return;
    const latest = currentViewModel().ui.source_selection ?? {};
    const latestSelected = selectedSourceIdsWithHiddenPreserved(latest);
    replaceCurrentSourceSelection({
      ...latest,
      query: latest.query ?? query,
      status: "search_error",
      search_state: "error",
      status_filter: status,
      filters,
      error_message: error instanceof Error ? error.message : "알 수 없는 오류",
      selected_document_ids: latestSelected.selected_document_ids,
      selected_evidence_ids: latestSelected.selected_evidence_ids,
      selected_research_source_ids: latestSelected.selected_research_source_ids
    }, { scope: "search" });
    setWorkflowNotice("error", `자료 검색 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
  }
}

function loadMoreSourceResults() {
  const current = currentViewModel().ui.source_selection ?? {};
  const visibleResultLimit = Math.max(Number(current.visible_result_limit) || 10, 10);
  replaceCurrentSourceSelection({ ...current, visible_result_limit: visibleResultLimit + 10 }, { scope: "results" });
}

function researchJobMatchesCurrentSelection(jobId) {
  return currentViewModel().step === "source_selection"
    && currentViewModel().ui.source_selection?.research_request?.job_id === jobId;
}

async function handleResearchJobTerminal(jobId, query, payload) {
  if (!researchJobMatchesCurrentSelection(jobId)) return;
  const current = currentViewModel().ui.source_selection ?? {};
  const status = payload?.job?.status ?? payload?.status;
  const researchRequest = {
    ...(current.research_request ?? {}),
    ...payload,
    status,
    job_id: jobId
  };
  if (status === "succeeded") {
    replaceCurrentSourceSelection({ ...current, research_request: researchRequest, status: "research_results", search_state: "searching", error_message: "" }, { scope: "research" });
    const latest = currentViewModel().ui.source_selection ?? {};
    await searchSourceSelection({
      query: latest.query ?? query,
      status: latest.status_filter ?? "all",
      filters: latest.filters ?? {},
      includePendingResearch: true
    });
    return;
  }
  const retryable = payload?.job?.intent?.runtime?.retryable === true || payload?.job?.retryable === true;
  const retryOf = retryable && researchRequest.job_descriptor
    ? { identity: jobId, status: "failed", attempt: researchRequest.attempt ?? payload?.job?.attempt_count ?? 1, descriptor: researchRequest.job_descriptor }
    : null;
  replaceCurrentSourceSelection({
    ...current,
    research_request: { ...researchRequest, retryable, ...(retryOf ? { retry_of: retryOf } : {}) },
    status: "research_error",
    search_state: "error",
    error_message: payload?.job?.error ?? `Research job ended with status ${status ?? "unknown"}`
  }, { scope: "research" });
  setWorkflowNotice("error", `Research 요청 실패: ${payload?.job?.error ?? "재시도 가능한 상태인지 확인해 주세요."}`);
}

function startResearchJobPolling(jobId, query) {
  if (!jobId) return;
  stopResearchJobPolling();
  const poller = createResearchJobPoller({
    jobId,
    intervalMs: 1000,
    getStatus: (currentJobId) => codexProvider.getResearchJobStatus(currentJobId),
    onStatus: async (payload) => {
      if (!researchJobMatchesCurrentSelection(jobId)) return;
      const current = currentViewModel().ui.source_selection ?? {};
      replaceCurrentSourceSelection({
        ...current,
        research_request: {
          ...(current.research_request ?? {}),
          ...payload,
          job_id: jobId,
          status: payload?.job?.status ?? payload?.status
        }
      }, { scope: "research" });
    },
    onTerminal: (payload) => handleResearchJobTerminal(jobId, query, payload),
    onError: async (error) => {
      if (!researchJobMatchesCurrentSelection(jobId)) return;
      const current = currentViewModel().ui.source_selection ?? {};
      replaceCurrentSourceSelection({
        ...current,
        research_request: { ...(current.research_request ?? {}), job_id: jobId, status: "poll_error", retryable: true },
        status: "research_error",
        search_state: "error",
        error_message: error instanceof Error ? error.message : "Research job status를 확인하지 못했습니다."
      }, { scope: "research" });
    }
  });
  researchJobPoller = poller;
  researchPollPromise = poller.start();
  researchPollPromise.then(
    () => {
      if (researchJobPoller === poller) {
        researchJobPoller = null;
        researchPollPromise = null;
      }
    },
    (error) => {
      if (researchJobPoller === poller) {
        researchJobPoller = null;
        researchPollPromise = null;
      }
      setWorkflowNotice("error", `Research polling 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  );
}

function buildDraftRecoveryRequest(selectedOptionId, researchJobId = null) {
  const accumulated = state.timeline.accumulated ?? {};
  return {
    schema_version: "0.4",
    route: "new_content",
    workflow_session_id: state.timeline.workflowSessionId,
    workflow_kind: state.timeline.workflowKind ?? "live",
    turn_id: createWorkflowTurnId(),
    mode: "next",
    target_step: "draft_review",
    current_step: "draft_review",
    selected_option_id: selectedOptionId,
    selected_document_ids: accumulated.selected_document_ids ?? [],
    selected_evidence_ids: accumulated.selected_evidence_ids ?? [],
    state: {
      target_track: accumulated.target_track,
      target_channel: accumulated.target_channel,
      content_purpose: accumulated.content_purpose,
      purpose_confirmed: accumulated.purpose_confirmed,
      selected_topic_id: accumulated.selected_topic_id,
      selected_angle_id: accumulated.selected_angle_id,
      selected_document_ids: accumulated.selected_document_ids ?? [],
      selected_evidence_ids: accumulated.selected_evidence_ids ?? [],
      claim_research_job_id: researchJobId ?? accumulated.claim_research_job_id ?? null
    },
    responses: [],
    current_response: null
  };
}

function updateClaimResearchStatus(status) {
  const index = state.timeline.selectedIndex;
  const current = state.timeline.responses[index];
  if (!current || current.step !== "draft_review") return;
  const next = structuredClone(current);
  next.state_patch ??= {};
  next.state_patch.metadata ??= {};
  next.state_patch.metadata.claim_research_request = { ...(next.state_patch.metadata.claim_research_request ?? {}), status };
  next.ui ??= {};
  next.ui.draft ??= {};
  next.ui.draft.metadata ??= {};
  next.ui.draft.metadata.claim_research_request = next.state_patch.metadata.claim_research_request;
  state.timeline = selectTimelineIndex({ ...state.timeline, responses: state.timeline.responses.map((item, itemIndex) => itemIndex === index ? next : item) }, index);
}

function applyProviderResponse(payload, request) {
  const response = payload.response;
  state.timeline = request.mode === "start"
    ? createLiveTimeline(response, { workflowSessionId: state.timeline.workflowSessionId })
    : appendTimelineResponse(state.timeline, response);
  if (state.timeline.workflowKind === "live" && state.timeline.workflowSessionId) {
    setUrlSession(state.timeline.workflowSessionId);
  }
  const assistantTurn = assistantTurnFromResponse(response);
  assistantTurn.revealPending = true;
  appendConversationTurn(assistantTurn);
  state.selectionRevealPending = true;
  state.rightRevealPending = true;
  state.lastFailedRequestSignature = null;
  state.conversationScrollTarget = "latest-user";
  state.forceHistorySelection = false;
  clearWorkflowNotice();
  return assistantTurn;
}

async function runDraftRecoveryRequest(selectedOptionId, researchJobId = null) {
  if (state.isGenerating) return;
  const request = buildDraftRecoveryRequest(selectedOptionId, researchJobId);
  appendConversationTurn({
    role: "user",
    turnKey: `user-${request.turn_id}`,
    turnId: request.turn_id,
    mode: request.mode,
    targetStep: request.target_step,
    currentStep: request.current_step,
    selectedOptionId,
    message: selectedOptionId === "attach_claim_research" ? "Research 결과 연결" : "Reviewer 다시 검수"
  });
  state.isGenerating = true;
  state.pendingTurn = pendingTurnFromRequest(request);
  state.conversationScrollTarget = "latest-user";
  setWorkflowNotice("info", selectedOptionId === "attach_claim_research" ? "Research 결과를 자료 Context에 연결하고 있습니다." : "추가 Writer 호출 없이 Reviewer가 다시 검수하고 있습니다.");
  renderApp();
  try {
    const payload = await codexProvider.respond(request);
    const assistantTurn = applyProviderResponse(payload, request);
    renderApp();
    revealAssistantResponse(assistantTurn.turnKey, assistantTurn);
    revealCenterSelection();
    revealRightPanel();
    if (selectedOptionId === "attach_claim_research") {
      await runDraftRecoveryRequest("recheck_draft");
    }
  } catch (error) {
    setWorkflowNotice("error", `자료 보강 후 검수 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    renderApp();
  } finally {
    state.isGenerating = false;
    state.generatingElapsedSeconds = 0;
    state.pendingTurn = null;
    state.conversationScrollTarget = "latest-user";
    renderApp();
  }
}

function startClaimResearchPolling(jobId) {
  if (!jobId) return;
  claimResearchJobPoller?.stop();
  const poller = createResearchJobPoller({
    jobId,
    intervalMs: 1000,
    getStatus: (currentJobId) => codexProvider.getResearchJobStatus(currentJobId),
    onStatus: (payload) => {
      const status = payload?.job?.status ?? payload?.status;
      setWorkflowNotice("info", status === "succeeded" ? "Research 결과를 연결하고 있습니다." : "Reviewer가 요청한 Research 자료를 찾고 있습니다.");
      renderApp();
    },
    onTerminal: async (payload) => {
      const status = payload?.job?.status ?? payload?.status;
      if (status === "succeeded") {
        await runDraftRecoveryRequest("attach_claim_research", jobId);
      } else {
        updateClaimResearchStatus("failed");
        setWorkflowNotice("error", `Claim Research가 ${status ?? "알 수 없는 상태"}로 종료되었습니다. 결과를 확인한 뒤 다시 시도해 주세요.`);
        renderApp();
      }
    },
    onError: (error) => {
      setWorkflowNotice("error", `Claim Research 상태를 확인하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
      renderApp();
    }
  });
  claimResearchJobPoller = poller;
  claimResearchPollPromise = poller.start();
  claimResearchPollPromise.finally(() => {
    if (claimResearchJobPoller === poller) {
      claimResearchJobPoller = null;
      claimResearchPollPromise = null;
    }
  });
}

async function requestResearchFromSourceSelection({ query = "", retry = false } = {}) {
  const current = currentViewModel().ui.source_selection ?? {};
  if (state.researchRequestPending || current.research_request?.status === "research_running") return;
  const resolvedQuery = resolveResearchCtaQuery({ ...current, explicit_search_query: query });
  if (resolvedQuery.length < 2) return;
  const selectedIds = selectedSourceIdsWithHiddenPreserved(current);
  const request = buildRespondRequest();
  state.researchRequestPending = true;
  replaceCurrentSourceSelection({
    ...current,
    ...selectedIds,
    status: "research_running",
    search_state: "searching",
    error_message: "",
    research_request: { status: "research_running", query: resolvedQuery }
  }, { scope: "research" });
  try {
    const response = await fetch("/api/research/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "new_search",
        query: resolvedQuery,
        state: request.state,
        workflow_session_id: request.workflow_session_id,
        turn_id: request.turn_id,
        turn: state.timeline.responses.length + 1,
        target_channel: request.state?.target_channel,
        ...(retry && current.research_request?.retry_of ? {
          retry_of: current.research_request.retry_of,
          attempt: Number(current.research_request.retry_of.attempt ?? 1) + 1
        } : {})
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error ?? "Research 요청을 시작하지 못했습니다.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    if (!payload.job_id) throw new Error("Research request did not return a job ID.");
    replaceCurrentSourceSelection({
      ...currentViewModel().ui.source_selection,
      ...selectedIds,
      status: "research_running",
      search_state: "searching",
      research_request: { ...payload, status: payload.status ?? "research_running", query: resolvedQuery },
      error_message: ""
    }, { scope: "research" });
    startResearchJobPolling(payload.job_id, resolvedQuery);
    clearWorkflowNotice();
  } catch (error) {
    const payload = error?.payload ?? {};
    replaceCurrentSourceSelection({
      ...currentViewModel().ui.source_selection,
      ...selectedIds,
      status: "research_error",
      search_state: "error",
      research_request: { ...payload, status: payload.status ?? "research_failed", query: resolvedQuery, retryable: error?.status === 429 || payload.retryable === true },
      error_message: error instanceof Error ? error.message : "Research 요청을 시작하지 못했습니다."
    }, { scope: "research" });
    setWorkflowNotice("error", `Research 요청 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
  } finally {
    state.researchRequestPending = false;
    const latest = currentViewModel().ui.source_selection ?? {};
    replaceCurrentSourceSelection(latest, { scope: "research" });
  }
}

function updateSourceSelectionFilters(input = {}) {
  const current = currentViewModel().ui.source_selection ?? {};
  const selectedIds = selectedSourceIdsWithHiddenPreserved(current);
  const selectedRecords = mergeSelectedSourceRecords(current, [], [], selectedIds.selected_document_ids, selectedIds.selected_evidence_ids, selectedIds.selected_research_source_ids);
  const nextStatus = input.status ?? current.status_filter ?? "all";
  const nextFilters = { ...(current.filters ?? {}), ...(input.filters ?? {}) };
  if (nextStatus !== (current.status_filter ?? "all")) {
    searchSourceSelection({ query: input.query ?? current.query ?? "", status: nextStatus, filters: nextFilters, ...selectedIds });
    return;
  }
  replaceCurrentSourceSelection({ ...current, ...selectedIds, ...selectedRecords, status_filter: nextStatus, filters: nextFilters, search_state: "results_ready" }, { scope: "search" });
}

async function showResearchDetail(evidenceId) {
  if (!evidenceId) return;
  try {
    const detail = await codexProvider.getResearchEvidenceDetail(evidenceId);
    const current = currentViewModel().ui.source_selection ?? {};
    replaceCurrentSourceSelection({ ...current, research_detail: detail }, { scope: "detail" });
  } catch (error) {
    setWorkflowNotice("error", `Evidence 상세 조회 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    renderApp();
  }
}

function showSourceDocumentDetail(documentId) {
  if (!documentId) return;
  const current = currentViewModel().ui.source_selection ?? {};
  const document = [...(current.knowledge_documents ?? []), ...(current.selected_documents ?? [])]
    .find((item) => (item.document_id ?? item.id) === documentId);
  if (!document) return;
  replaceCurrentSourceSelection({ ...current, source_document_detail: document, research_detail: null }, { scope: "detail" });
}

function showResearchSourceDetail(sourceId) {
  if (!sourceId) return;
  const current = currentViewModel().ui.source_selection ?? {};
  const source = (current.research_sources ?? []).find((item) => (item.source_id ?? item.id) === sourceId);
  if (!source) return;
  replaceCurrentSourceSelection({ ...current, research_source_detail: source, research_detail: null, source_document_detail: null }, { scope: "detail" });
}

function removeSelectedSource(kind, sourceId) {
  const current = currentViewModel().ui.source_selection ?? {};
  if (kind === "research_source") {
    replaceCurrentSourceSelection({ ...current, selected_research_source_ids: (current.selected_research_source_ids ?? []).filter((id) => id !== sourceId) }, { scope: "selection" });
    return;
  }
  updateSourceSelectionMembership(kind, sourceId, false);
}

async function clearSelectedSources() {
  const current = currentViewModel().ui.source_selection ?? {};
  const cleared = clearSourceSelection(current);
  const selectedRecords = mergeSelectedSourceRecords(cleared, cleared.knowledge_documents ?? [], cleared.research_evidence ?? [], cleared.selected_document_ids, cleared.selected_evidence_ids, cleared.selected_research_source_ids);
  state.sourceSelectionSavePending = true;
  setSourceSelectionContinueEnabled(false);
  replaceCurrentSourceSelection({ ...cleared, ...selectedRecords, selection_save_status: "saving" }, { scope: "selection" });
  const projection = buildSourceSelectionProjection(current);
  try {
    for (const sourceId of [...projection.effective_selected.document_ids]) await persistSourceSelectionMutation({ kind: "document", sourceId, selected: false }, current);
    for (const sourceId of [...projection.effective_selected.evidence_ids]) await persistSourceSelectionMutation({ kind: "evidence", sourceId, selected: false }, current);
    state.sourceSelectionSavePending = false;
    setSourceSelectionContinueEnabled(true);
    replaceCurrentSourceSelection({ ...currentViewModel().ui.source_selection, selection_save_status: "saved" }, { scope: "selection" });
  } catch (error) {
    state.sourceSelectionSavePending = false;
    setSourceSelectionContinueEnabled(true);
    setWorkflowNotice("error", `자료 선택을 저장하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    replaceCurrentSourceSelection({ ...currentViewModel().ui.source_selection, selection_save_status: "error" }, { scope: "selection" });
  }
}

async function persistSourceSelectionMutation(action, selection) {
  const workflowSessionId = state.timeline.workflowSessionId;
  if (!workflowSessionId || !selection.source_selection_artifact_id) return null;
  const response = await fetch("/api/workflow/source-selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_session_id: workflowSessionId, action })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Source Selection 변경을 저장하지 못했습니다.");
  return payload;
}

async function updateSourceSelectionMembership(kind, sourceId, selected) {
  const current = currentViewModel().ui.source_selection ?? {};
  const mutationSequence = (state.sourceSelectionMutationSequence ?? 0) + 1;
  state.sourceSelectionMutationSequence = mutationSequence;
  if (kind === "research_source") {
    const selectedResearchSourceIds = new Set(current.selected_research_source_ids ?? []);
    if (selected) selectedResearchSourceIds.add(sourceId);
    else selectedResearchSourceIds.delete(sourceId);
    replaceCurrentSourceSelection({ ...current, selected_research_source_ids: [...selectedResearchSourceIds] }, { scope: "selection" });
    return;
  }
  const next = applySourceSelectionChange(current, { kind, sourceId, selected });
  const selectedRecords = mergeSelectedSourceRecords(next, next.knowledge_documents ?? [], next.research_evidence ?? [], next.selected_document_ids, next.selected_evidence_ids, next.selected_research_source_ids);
  state.sourceSelectionSavePending = true;
  setSourceSelectionContinueEnabled(false);
  replaceCurrentSourceSelection({ ...next, ...selectedRecords, selection_save_status: "saving" }, { scope: "selection" });
  try {
    const persisted = await persistSourceSelectionMutation({ kind, sourceId, selected }, next);
    if (state.sourceSelectionMutationSequence !== mutationSequence) return;
    if (!persisted) {
      state.sourceSelectionSavePending = false;
      setSourceSelectionContinueEnabled(true);
      replaceCurrentSourceSelection({ ...currentViewModel().ui.source_selection, selection_save_status: "saved" }, { scope: "selection" });
      return;
    }
    const latest = currentViewModel().ui.source_selection ?? {};
    const persistedSelection = { ...persisted.selection, source_selection_artifact_id: persisted.artifact.id };
    const records = mergeSelectedSourceRecords({ ...latest, ...persistedSelection }, latest.knowledge_documents ?? [], latest.research_evidence ?? [], persistedSelection.selected_document_ids, persistedSelection.selected_evidence_ids, persistedSelection.selected_research_source_ids);
    state.sourceSelectionSavePending = false;
    setSourceSelectionContinueEnabled(true);
    replaceCurrentSourceSelection({ ...latest, ...persistedSelection, ...records, selection_save_status: "saved" }, { scope: "selection" });
  } catch (error) {
    if (state.sourceSelectionMutationSequence !== mutationSequence) return;
    state.sourceSelectionSavePending = false;
    setSourceSelectionContinueEnabled(true);
    const rollbackRecords = mergeSelectedSourceRecords(current, current.knowledge_documents ?? [], current.research_evidence ?? [], current.selected_document_ids, current.selected_evidence_ids, current.selected_research_source_ids);
    replaceCurrentSourceSelection({ ...current, ...rollbackRecords, selection_save_status: "error" }, { scope: "selection" });
    setWorkflowNotice("error", `자료 선택을 저장하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
  }
}

async function reviewResearchEvidence({ evidence_id: evidenceId, decision, confidence, reliability }) {
  if (!evidenceId || !decision) return;
  try {
    const persistedDecision = decision === "pending" ? "needs_context" : decision;
    await codexProvider.reviewResearchEvidence({ target_type: "evidence", target_id: evidenceId, decision: persistedDecision, confidence, reliability, reviewer_id: "local-ui-reviewer", note: "v0.4 source selection review" });
    const current = currentViewModel().ui.source_selection ?? {};
    await searchSourceSelection({ query: current.query ?? "", status: current.status_filter ?? "all", filters: current.filters ?? {} });
    await showResearchDetail(evidenceId);
  } catch (error) {
    setWorkflowNotice("error", `Evidence 검수 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    renderApp();
  }
}

async function reviewResearchSource({ source_id: sourceId, decision, reliability }) {
  if (!sourceId || !decision) return;
  try {
    const persistedDecision = decision === "pending" ? "needs_context" : decision;
    await codexProvider.reviewResearchEvidence({ target_type: "source", target_id: sourceId, decision: persistedDecision, reliability, reviewer_id: "local-ui-reviewer", note: "v0.4 source selection source review" });
    const current = currentViewModel().ui.source_selection ?? {};
    await searchSourceSelection({ query: current.query ?? "", status: current.status_filter ?? "all", filters: current.filters ?? {} });
    showResearchSourceDetail(sourceId);
  } catch (error) {
    setWorkflowNotice("error", `Research Source 검수 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    renderApp();
  }
}

const panels = createPanelController({
  nodes,
  getMode: () => state.mode,
  getBrunchChat: () => state.brunchChat,
  getTimeline: () => state.timeline,
  getConversationTurns: () => state.conversationTurns,
  getIsGenerating: () => state.isGenerating,
  getGeneratingElapsedSeconds: () => state.generatingElapsedSeconds,
  getBrunchChatActivity: () => state.brunchChat?.generationActivity ?? "request_received",
  getPendingTurn: () => state.pendingTurn,
  getWorkflowCompleted: () => state.workflowCompleted,
  getSelectionRevealPending: () => state.selectionRevealPending,
  getRightRevealPending: () => state.rightRevealPending,
  getWorkflowNotice: () => state.workflowNotice,
  getSourceSelection: () => currentViewModel().ui.source_selection ?? {},
  onOpenDebug: drawers.openDebugDrawer,
  onNavigate: navigateTimeline,
  onNavigateStep: navigateTimelineStep,
  onContinue: continueWorkflow,
  onChatChoice: handleBrunchChatChoice,
  onChatDraft: handleBrunchChatDraft,
  onChatContinue: continueBrunchChat,
  onChatCopy: copyBrunchChatTurn,
  onChatRegenerate: regenerateBrunchChatTurn,
  onChatActivateVersion: activateBrunchChatVersion,
  onChatRestoreVersion: restoreBrunchChatVersion,
  onChatBranch: branchBrunchChatTurn,
  onChatModelSelect: handleBrunchChatModelSelect,
  onResearchRequest: requestResearchFromSourceSelection,
  onStop: stopGeneration,
  onChatStop: stopGeneration
  ,onSourceSearch: searchSourceSelection,
  onSourceFilter: updateSourceSelectionFilters,
  onSourceLoadMore: loadMoreSourceResults,
  onSourceSelectionChange: updateSourceSelectionMembership,
  onSourceRemove: removeSelectedSource,
  onSourceClear: clearSelectedSources,
  onResearchDetail: showResearchDetail,
  onResearchSourceDetail: showResearchSourceDetail,
  onSourceDocumentDetail: showSourceDocumentDetail,
  onResearchDetailClose: () => replaceCurrentSourceSelection({ ...(currentViewModel().ui.source_selection ?? {}), research_detail: null, research_source_detail: null, source_document_detail: null }, { scope: "detail" }),
  onResearchReview: reviewResearchEvidence,
  onResearchSourceReview: reviewResearchSource
});

function updateConversationBottomInset(autoScrollTarget = null) {
  // Extra submit range belongs inside the scroll content, not in the flex item's padding.
  const inset = autoScrollTarget === "latest-user" ? "600px" : "200px";
  nodes.center.style.setProperty("--conversation-bottom-inset", inset);
}

function scrollConversationToBottom() {
  const panel = getConversationScrollElement();
  if (!panel) return;

  requestAnimationFrame(() => {
    panel.scrollTop = panel.scrollHeight;
  });
}

function scrollConversationToTop(epoch = null) {
  const panel = getConversationScrollElement();
  if (!panel) return;

  requestAnimationFrame(() => {
    if (epoch !== null && epoch !== brunchChatScrollEpoch) return;
    panel.scrollTop = 0;
  });
}


function conversationScrollTopGap(panel) {
  const value = Number.parseFloat(getComputedStyle(panel).getPropertyValue("--conversation-scroll-offset"));
  return Number.isFinite(value) ? value : 128;
}

function scrollConversationTurnToTop(turn, { gap = null, epoch = null, onSettled = null } = {}) {
  const panel = getConversationScrollElement();
  if (!panel || !turn) return;
  const targetGap = gap ?? conversationScrollTopGap(panel);
  const isCurrent = () => epoch === null || epoch === brunchChatScrollEpoch;

  const align = () => {
    if (!isCurrent() || !turn.isConnected || !panel.isConnected) return;
    const panelRect = panel.getBoundingClientRect();
    const targetRect = turn.getBoundingClientRect();
    const nextTop = panel.scrollTop + targetRect.top - panelRect.top - targetGap;
    panel.scrollTo({ top: Math.max(0, nextTop), left: panel.scrollLeft, behavior: "auto" });
  };

  requestAnimationFrame(() => {
    if (!isCurrent()) return;
    align();
    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      align();
      window.setTimeout(() => {
        if (isCurrent()) {
          align();
          onSettled?.();
        }
      }, 0);
    });
  });
}


function scrollConversationStepToTop(step) {
  const panel = getConversationScrollElement();
  if (!panel || !step) return;

  const turns = Array.from(panel.querySelectorAll(".conversation-turn"));
  const target =
    turns.find((turn) => turn.dataset.stepId === step && turn.classList.contains("conversation-assistant-turn")) ??
    turns.find((turn) => turn.dataset.stepId === step);

  if (target) {
    scrollConversationTurnToTop(target);
  }
}


function scrollLatestUserTurnToTop(epoch = null, onSettled = null) {
  const panel = getConversationScrollElement();
  if (!panel) return;

  requestAnimationFrame(() => {
    if (epoch !== null && epoch !== brunchChatScrollEpoch) return;
    const userTurns = panel.querySelectorAll(".user-turn");
    const latestUserTurn = userTurns[userTurns.length - 1];

    if (!latestUserTurn) {
      panel.scrollTop = panel.scrollHeight;
      onSettled?.();
      return;
    }

    scrollConversationTurnToTop(latestUserTurn, {
      gap: conversationScrollTopGap(panel),
      epoch,
      onSettled
    });
  });
}

function getBrunchChatHistoryScrollElement() {
  return nodes.right?.querySelector(".brunch-chat-response-history") ?? null;
}

function captureBrunchChatHistoryScrollPosition() {
  const element = getBrunchChatHistoryScrollElement();
  if (!element) return null;
  return { top: element.scrollTop, left: element.scrollLeft };
}

function restoreBrunchChatHistoryScrollPosition(snapshot) {
  if (!snapshot) return;
  const restore = () => {
    const element = getBrunchChatHistoryScrollElement();
    if (!element) return;
    element.scrollLeft = snapshot.left;
    element.scrollTop = snapshot.top;
  };
  restore();
  requestAnimationFrame(restore);
}

function scrollBrunchChatHistoryToBottom() {
  requestAnimationFrame(() => {
    const element = getBrunchChatHistoryScrollElement();
    if (element) element.scrollTop = element.scrollHeight;
  });
}


function isHistoryTimelineView() {
  return state.timeline.selectedIndex >= 0 && state.timeline.selectedIndex < state.timeline.responses.length - 1;
}

function flattenStateValues(value, result = []) {
  if (value === undefined || value === null) return result;

  if (Array.isArray(value)) {
    value.forEach((item) => flattenStateValues(item, result));
    return result;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((item) => flattenStateValues(item, result));
    return result;
  }

  result.push(String(value));
  return result;
}

function inferHistorySelectedOption(viewModel) {
  const options = viewModel.ui.options ?? [];
  if (options.length === 0) return null;

  const optionIds = new Set(options.map((option) => option.id));
  const nextStep = getNextWorkflowStep(viewModel.step);
  const userTurns = state.conversationTurns ?? [];

  const matchedUserTurn = [...userTurns]
    .reverse()
    .find((turn) => {
      if (!turn || turn.role !== "user") return false;
      if (!optionIds.has(turn.selectedOptionId)) return false;

      return (
        turn.currentStep === viewModel.step ||
        turn.targetStep === viewModel.step ||
        turn.targetStep === nextStep
      );
    });

  if (!matchedUserTurn) return null;

  return options.find((option) => option.id === matchedUserTurn.selectedOptionId) ?? null;
}


function renderReadonlyHistoryOptions(viewModel, selectedOption) {
  const options = viewModel.ui.options ?? [];

  if (selectedOption) {
    return `<div class="history-choice-card selected" title="${escapeHtml(selectedOption.title)}">
      <b>✓</b>
      <div>
        <span>${escapeHtml(selectedOption.title)}</span>
        <small>${escapeHtml(selectedOption.description ?? "실제로 선택한 항목입니다.")}</small>
      </div>
    </div>`;
  }

  if (options.length === 0) {
    return `<div class="history-choice-card unknown">
      <b>?</b>
      <div>
        <span>선택 기록을 확인할 수 없음</span>
        <small>이 단계의 선택 요청 기록이 복원되지 않았습니다.</small>
      </div>
    </div>`;
  }

  return `<div class="history-readonly-options">
    ${options
      .map((option, index) => `<div class="history-readonly-option" title="${escapeHtml(option.title)}">
        <b>${index + 1}</b>
        <div>
          <span>${escapeHtml(option.title)}</span>
          ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
        </div>
      </div>`)
      .join("")}
  </div>`;
}

function applyHistorySelectionState() {
  const selection = nodes.center.querySelector(".center-selection");
  if (!selection) return;

  if (!state.forceHistorySelection && !isHistoryTimelineView()) {
    return;
  }

  const viewModel = currentViewModel();
  const selectedOption = inferHistorySelectedOption(viewModel);

  selection.classList.add("history-selection");
  selection.innerHTML = `
    <p class="choice-title">${escapeHtml(viewModel.stepLabel)}</p>

    ${renderReadonlyHistoryOptions(viewModel, selectedOption)}

    <p class="history-selection-note">
      ${state.forceHistorySelection ? "대화가 중단되었습니다. 이 단계부터 다시 진행하려면 아래 버튼을 눌러주세요." : "이전 단계 조회 중입니다. 이 단계부터 다시 진행하려면 아래 버튼을 눌러주세요."}
    </p>

    <button class="return-step-button" type="button" data-return-to-step>
      해당 단계로 돌아가기
    </button>
  `;
}


function returnToSelectedTimelineStep() {
  const index = state.timeline.selectedIndex;

  if (state.forceHistorySelection && (index < 0 || index >= state.timeline.responses.length - 1)) {
    state.forceHistorySelection = false;
    clearWorkflowNotice();
    renderApp();
    return;
  }

  if (index < 0 || index >= state.timeline.responses.length - 1) {
    return;
  }

  const responses = state.timeline.responses.slice(0, index + 1);

  state.timeline = selectTimelineIndex(
    {
      ...state.timeline,
      responses,
      requestHistory: Array.isArray(state.timeline.requestHistory)
        ? state.timeline.requestHistory.slice(0, index + 1)
        : state.timeline.requestHistory,
      selectedIndex: index,
      selectedResponse: responses[index],
      metadata: responses.map((response, responseIndex) => ({
        step: response.step,
        label: response.ui?.title ?? response.step,
        index: responseIndex,
        position: responseIndex + 1
      }))
    },
    index
  );

  state.conversationTurns = conversationTurnsFromTimeline(state.timeline);
  state.pendingTurn = null;
  state.isGenerating = false;
  state.generatingElapsedSeconds = 0;
  state.forceHistorySelection = false;
  state.shouldScrollConversation = false;
  state.conversationScrollTarget = `step:${currentViewModel().step}`;
  clearWorkflowNotice();
  renderApp();
}

document.addEventListener("click", (event) => {
  if (state.mode === "v06") {
    const v06Step = event.target.closest("[data-v06-step]");
    if (v06Step && !v06Step.disabled) {
      state.v06.selectedStep = v06Step.dataset.v06Step;
      state.v06.selectedFindingId = null;
      state.v06.selectedClaimId = null;
      state.v06.selectedNoteId = null;
      state.v06.editing = null;
      renderApp();
      return;
    }
  }
  const returnButton = event.target.closest("[data-return-to-step]");
  if (!returnButton) return;

  returnToSelectedTimelineStep();
});


function getConversationScrollElement() {
  return nodes.center?.querySelector(".message-stack") ?? nodes.center;
}


function captureConversationScrollPosition(preferredAnchorKey = "") {
  const el = getConversationScrollElement();
  if (!el) return null;

  const containerRect = el.getBoundingClientRect();
  const anchors = Array.from(el.querySelectorAll(".conversation-turn"));
  const preferredAnchor = preferredAnchorKey
    ? anchors.find((anchor) => anchor.dataset.turnKey === preferredAnchorKey)
    : null;
  const anchorIndex = preferredAnchor
    ? anchors.indexOf(preferredAnchor)
    : anchors.findIndex((anchor) => {
    const rect = anchor.getBoundingClientRect();
    return rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
  });
  const anchor = preferredAnchor ?? anchors[anchorIndex] ?? null;
  const anchorRect = anchor?.getBoundingClientRect();

  return {
    top: el.scrollTop,
    left: el.scrollLeft,
    height: el.scrollHeight,
    clientHeight: el.clientHeight,
    anchorKey: anchor?.dataset.turnKey ?? "",
    anchorIndex,
    anchorOffset: anchorRect ? anchorRect.top - containerRect.top : 0
  };
}

function restoreConversationScrollPosition(snapshot, epoch = null) {
  if (!snapshot) return;

  const el = getConversationScrollElement();
  if (!el) return;
  const isCurrent = () => epoch === null || epoch === brunchChatScrollEpoch;

  const findAnchor = () => {
    const anchors = Array.from(el.querySelectorAll(".conversation-turn"));
    return (
      anchors.find((anchor) => anchor.dataset.turnKey === snapshot.anchorKey) ??
      anchors[snapshot.anchorIndex] ??
      null
    );
  };

  const restore = () => {
    if (!isCurrent() || !el.isConnected) return;
    el.scrollLeft = snapshot.left;
    const anchor = findAnchor();
    if (!anchor) {
      el.scrollTop = snapshot.top;
      return;
    }

    const containerRect = el.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    el.scrollTop = el.scrollTop + anchorRect.top - containerRect.top - snapshot.anchorOffset;
  };

  el.scrollTop = snapshot.top;
  restore();

  requestAnimationFrame(() => {
    if (!isCurrent()) return;
    restore();

    requestAnimationFrame(() => {
      if (!isCurrent()) return;
      restore();
    });
  });
}

function restoreV06DetailTrigger(detail, region) {
  requestAnimationFrame(() => {
    const root = region === "center" ? nodes.center : nodes.right;
    const triggerNode = [...(root?.querySelectorAll?.("[data-v06-detail-trigger]") ?? [])]
      .find((node) => node.dataset.v06DetailTrigger === detail);
    triggerNode?.focus();
  });
}

function closeV06DetailModal() {
  if (state.mode !== "v06" || !state.v06.detailModal) return;
  const detail = state.v06.detailTrigger;
  const region = state.v06.detailTriggerRegion;
  state.v06.detailModal = null;
  state.v06.detailTrigger = null;
  state.v06.detailTriggerRegion = null;
  renderApp();
  restoreV06DetailTrigger(detail, region);
}

function renderApp() {
  const isV06Mode = state.mode === "v06" || state.mode === "v06-start";
  const isBrunchChatMode = state.mode === "brunch-chat";
  document.body?.classList.toggle("v06-active", isV06Mode);
  document.body?.classList.toggle("brunch-chat-active", isBrunchChatMode);
  document.querySelector(".workspace")?.classList.toggle("v06-workspace", isV06Mode);
  document.querySelector(".workspace")?.classList.toggle("brunch-chat-workspace", isBrunchChatMode);
  if (isBrunchChatMode) {
    updateBrunchChatHeader();
    const debugLink = document.querySelector("#openV06Debug");
    if (debugLink) debugLink.hidden = true;
    const scrollEpoch = ++brunchChatScrollEpoch;
    const conversationScrollMode = brunchChatScrollMode;
    const historyScrollMode = brunchChatHistoryScrollMode;
    const conversationScrollSnapshot = conversationScrollMode === "preserve"
      ? captureConversationScrollPosition(brunchChatScrollAnchorKey)
      : null;
    const historyScrollSnapshot = historyScrollMode === "preserve"
      ? captureBrunchChatHistoryScrollPosition()
      : null;
    brunchChatScrollMode = conversationScrollMode === "latest-user" ? "latest-user" : "preserve";
    brunchChatHistoryScrollMode = "preserve";
    panels.render(currentViewModel());
    refreshWritingEditorReadiness();
    updateConversationBottomInset(conversationScrollMode === "latest-user" ? "latest-user" : null);
    requestAnimationFrame(() => {
      if (scrollEpoch !== brunchChatScrollEpoch) return;
      if (conversationScrollMode === "initial") scrollConversationToTop(scrollEpoch);
      else if (conversationScrollMode === "latest-user") {
        scrollLatestUserTurnToTop(scrollEpoch, () => {
          if (scrollEpoch === brunchChatScrollEpoch) brunchChatScrollMode = "preserve";
        });
      }
      else restoreConversationScrollPosition(conversationScrollSnapshot, scrollEpoch);

      if (historyScrollMode === "initial" || historyScrollMode === "latest") scrollBrunchChatHistoryToBottom();
      else restoreBrunchChatHistoryScrollPosition(historyScrollSnapshot);
    });
    return;
  }
  if (state.mode === "v06-start" && state.v06.start) {
    updateStartHeader();
    const debugLink = document.querySelector("#openV06Debug");
    if (debugLink) debugLink.hidden = true;
    renderV06Start({ nodes, state: state.v06, onSubmit: submitV06Start });
    return;
  }
  if (state.mode === "v06" && state.v06.operator) {
    const operator = state.v06.operator;
    ensureV06ContextSelection(operator, state.v06.selectedStep);
    const selectedStep = operator.steps.find((step) => step.id === state.v06.selectedStep);
    const headerVersion = document.querySelector(".brand-version");
    if (headerVersion) headerVersion.textContent = copyCatalog.brand.version;
    document.title = copyCatalog.brand.pageTitle;
    const debugLink = document.querySelector("#openV06Debug");
    if (debugLink) debugLink.hidden = false;
    renderV06Operator({
      nodes,
      operator,
      state: state.v06,
      onStep(step) {
        state.v06.selectedStep = step;
        state.v06.selectedFindingId = null;
        state.v06.selectedClaimId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        state.v06.detailTrigger = null;
        state.v06.editing = null;
        renderApp();
      },
      onFinding(findingId) {
        state.v06.selectedFindingId = findingId;
        state.v06.selectedClaimId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        renderApp();
      },
      onClaim(claimId) {
        state.v06.selectedClaimId = claimId;
        state.v06.selectedFindingId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        renderApp();
      },
      onNote(noteId) {
        state.v06.selectedNoteId = noteId;
        state.v06.selectedClaimId = null;
        state.v06.selectedFindingId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        renderApp();
      },
      onSource(sourceId) {
        state.v06.selectedSourceId = sourceId;
        state.v06.selectedNoteId = null;
        state.v06.selectedClaimId = null;
        state.v06.selectedFindingId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        renderApp();
      },
      onDirection(directionId) {
        state.v06.selectedDirectionId = directionId;
        state.v06.selectedSourceId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedClaimId = null;
        state.v06.selectedFindingId = null;
        state.v06.detailModal = null;
        renderApp();
      },
      onModal(detail) {
        if (detail?.open) {
          state.v06.detailModal = detail.detail;
          state.v06.detailTrigger = detail.detail;
      state.v06.detailTriggerRegion = document.activeElement?.closest?.(".conversation-panel") ? "center" : "right";
          renderApp();
          requestAnimationFrame(() => nodes.right.querySelector("[data-v06-close-detail]")?.focus());
          return;
        }
        closeV06DetailModal();
      },
      onReturnToStep() {
        state.v06.selectedStep = state.v06.operator.runtime_view?.current_user_step ?? state.v06.selectedStep;
        state.v06.selectedFindingId = null;
        state.v06.selectedClaimId = null;
        state.v06.selectedNoteId = null;
        state.v06.selectedSourceId = null;
        state.v06.selectedDirectionId = null;
        state.v06.detailModal = null;
        state.v06.detailTrigger = null;
        state.v06.editing = null;
        renderApp();
      },
      onEdit(editing) {
        state.v06.editing = editing;
        renderApp();
      },
      onAction: handleV06OperatorAction,
      onDebug() {
        window.location.href = operator.debug_url;
      }
    });
    if (state.v06.notice) {
      const notice = document.createElement("p");
      notice.className = "workflow-notice info v06-operator-notice";
      notice.textContent = state.v06.notice;
      nodes.center.prepend(notice);
    }
    const v06ResearchView = ["research_scope", "research_review"].includes(state.v06.selectedStep);
    if (state.v06.busy && !v06ResearchView) {
      const busy = document.createElement("p");
      busy.className = "workflow-notice info v06-operator-notice";
      busy.textContent = "작업 중입니다. 현재 단계 결과가 저장되면 화면을 갱신합니다.";
      nodes.center.prepend(busy);
    }
    if (state.v06.activeRuns.length > 0 && !state.v06.busy && !v06ResearchView) {
      const running = document.createElement("p");
      running.className = "workflow-notice info v06-operator-notice";
      running.textContent = "Provider 작업이 실행 중입니다.";
      nodes.center.prepend(running);
    }
    document.body?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.querySelector(".app-shell")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    void selectedStep;
    return;
  }
  const debugLink = document.querySelector("#openV06Debug");
  if (debugLink) debugLink.hidden = true;
  const autoScrollTarget = state.conversationScrollTarget;
  const shouldAutoScroll = state.shouldScrollConversation;
  const conversationScrollSnapshot = !shouldAutoScroll && !state.isGenerating
    ? captureConversationScrollPosition()
    : null;
  const rightScroll = nodes.right.querySelector(".right-scroll");
  const researchModal = nodes.right.querySelector("[data-research-detail-modal] .research-detail-modal");
  const rightPanelScrollSnapshot = rightScroll || researchModal
    ? {
      rightScrollTop: rightScroll?.scrollTop ?? 0,
      modalScrollTop: researchModal?.scrollTop ?? 0,
      hasModal: Boolean(researchModal)
    }
    : null;

  state.conversationScrollTarget = null;
  state.shouldScrollConversation = false;

  panels.render(currentViewModel());
  setSourceSelectionContinueEnabled(!state.sourceSelectionSavePending);
  applyHistorySelectionState();
  updateConversationBottomInset(autoScrollTarget);

  if (rightPanelScrollSnapshot) {
    const restoreRightPanelScroll = () => {
      const nextRightScroll = nodes.right.querySelector(".right-scroll");
      const nextResearchModal = nodes.right.querySelector("[data-research-detail-modal] .research-detail-modal");
      if (nextRightScroll) nextRightScroll.scrollTop = rightPanelScrollSnapshot.rightScrollTop;
      if (rightPanelScrollSnapshot.hasModal && nextResearchModal) nextResearchModal.scrollTop = rightPanelScrollSnapshot.modalScrollTop;
    };
    restoreRightPanelScroll();
    requestAnimationFrame(restoreRightPanelScroll);
  }

  if (autoScrollTarget === "latest-user") {
    scrollLatestUserTurnToTop();
    return;
  }

  if (autoScrollTarget?.startsWith("step:")) {
    scrollConversationStepToTop(autoScrollTarget.slice("step:".length));
    return;
  }

  if (shouldAutoScroll) {
    scrollConversationToBottom();
    return;
  }

  restoreConversationScrollPosition(conversationScrollSnapshot);
}



function navigateTimeline(event) {
  const direction = event.currentTarget.dataset.nav;
  state.timeline = direction === "previous" ? previousTimeline(state.timeline) : nextTimeline(state.timeline);
  state.conversationScrollTarget = `step:${currentViewModel().step}`;
  clearWorkflowNotice();
  renderApp();
}

function navigateTimelineStep(event) {
  const step = event.currentTarget.dataset.stepId;
  if (!step) return;
  state.timeline = selectTimelineStep(state.timeline, step);
  state.conversationScrollTarget = `step:${currentViewModel().step}`;
  clearWorkflowNotice();
  renderApp();
}

function selectedOptionId(viewModel) {
  return (
    nodes.center.querySelector(".center-option.selected")?.dataset.optionId ??
    viewModel.ui.options?.[0]?.id ??
    ""
  );
}

function freeReviseValue() {
  return nodes.center.querySelector(".free-revise textarea")?.value.trim() ?? "";
}

function userTurnFromRequest(request, viewModel) {
  const selectedOption = (viewModel.ui.options ?? []).find((option) => option.id === request.selected_option_id);
  const message = request.free_revise || selectedOption?.title || "진행하자";
  return {
    role: "user",
    turnKey: `user-${request.turn_id}`,
    turnId: request.turn_id,
    mode: request.mode,
    targetStep: request.target_step,
    currentStep: request.current_step,
    selectedOptionId: request.selected_option_id,
    message
  };
}

function pendingTurnFromRequest(request) {
  return {
    turnId: request.turn_id,
    mode: request.mode,
    targetStep: request.target_step,
    currentStep: request.current_step,
    selectedOptionId: request.selected_option_id
  };
}

function interruptedConversationTurn(viewModel) {
  return {
    role: "assistant",
    turnKey: `assistant-cancel-${Date.now()}`,
    step: viewModel.step,
    title: "작업 중단",
    message: "대화가 중단되었습니다.",
    recommendationReason: ""
  };
}

function assistantTurnFromResponse(response) {
  return {
    role: "assistant",
    turnKey: `assistant-step-${response.step}`,
    step: response.step,
    title: response.ui?.title ?? response.step,
    component: response.ui?.component ?? "",
    message: response.message ?? "",
    recommendationReason: response.recommendation?.reason ?? ""
  };
}

function restoredUserTurnFromRequest(request, responses = []) {
  const sourceResponse = responses.find((response) => response.step === request.current_step);
  const selectedOption = (sourceResponse?.ui?.options ?? []).find((option) => option.id === request.selected_option_id);

  return {
    role: "user",
    turnKey: `user-${request.turn_id}`,
    turnId: request.turn_id,
    mode: request.mode,
    targetStep: request.target_step,
    currentStep: request.current_step,
    selectedOptionId: request.selected_option_id,
    message: request.free_revise || selectedOption?.title || request.selected_option_id || "진행하자"
  };
}

function conversationTurnsFromTimeline(timeline) {
  const responses = timeline.responses ?? [];
  const requests = Array.isArray(timeline.requestHistory) ? timeline.requestHistory : [];

  if (requests.length === 0) {
    return responses.map((response) => assistantTurnFromResponse(response));
  }

  const turns = [];
  const count = Math.max(requests.length, responses.length);

  for (let index = 0; index < count; index += 1) {
    if (requests[index]) {
      turns.push(restoredUserTurnFromRequest(requests[index], responses));
    }

    if (responses[index]) {
      turns.push(assistantTurnFromResponse(responses[index]));
    }
  }

  return turns;
}


function appendConversationTurn(turn) {
  state.conversationTurns = [...state.conversationTurns, turn];

  if (turn.role === "user") {
    state.conversationScrollTarget = "latest-user";
  }
}

function formatGenerationElapsed(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value}s`;
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function updatePendingElapsedText() {
  const elapsedNode = nodes.center.querySelector("[data-pending-elapsed]");
  if (!elapsedNode) return;
  elapsedNode.textContent = `${formatGenerationElapsed(state.generatingElapsedSeconds)} 동안 작업 중입니다`;
}

function updatePendingActivityText(activity = "request_received") {
  state.brunchChat.generationActivity = activity;
  const activityNode = nodes.center.querySelector("[data-pending-activity]");
  if (!activityNode) return;
  activityNode.textContent = copyCatalog.brunchChat.generationActivity?.[activity] ?? copyCatalog.brunchChat.loading;
}

function startGenerationTimer() {
  clearGenerationTimer();
  state.generatingElapsedSeconds = 0;
  generationTimerId = window.setInterval(() => {
    state.generatingElapsedSeconds += 1;
    updatePendingElapsedText();
  }, 1000);
}

function clearGenerationTimer() {
  if (!generationTimerId) return;
  window.clearInterval(generationTimerId);
  generationTimerId = null;
}

function clearAssistantRevealTimers() {
  assistantRevealTimerIds.forEach((timerId) => window.clearTimeout(timerId));
  assistantRevealTimerIds = [];
}

function clearSelectionRevealTimers() {
  selectionRevealTimerIds.forEach((timerId) => window.clearTimeout(timerId));
  selectionRevealTimerIds = [];
}

function clearRightRevealTimers() {
  rightRevealTimerIds.forEach((timerId) => window.clearTimeout(timerId));
  rightRevealTimerIds = [];
}

function assistantRevealChunks(message) {
  const text = String(message ?? "");
  if (!text) return [];

  const words = text.match(/\S+\s*/g) ?? [text];
  // Keep the response in a few readable bursts. This feels like streamed model output
  // without the slow, character-by-character typewriter effect.
  const chunkCount = Math.min(words.length, Math.max(3, Math.min(8, Math.ceil(text.length / 28))));
  const wordsPerChunk = Math.max(1, Math.ceil(words.length / chunkCount));
  const chunks = [];

  for (let index = 0; index < words.length; index += wordsPerChunk) {
    chunks.push(words.slice(index, index + wordsPerChunk).join(""));
  }

  return chunks;
}

function revealAssistantResponse(turnKey, turn) {
  clearAssistantRevealTimers();
  turn.revealPending = false;

  const assistantTurn = Array.from(nodes.center.querySelectorAll(".conversation-assistant-turn"))
    .find((item) => item.dataset.turnKey === turnKey);
  if (!assistantTurn) return;

  const messageParagraph = assistantTurn.querySelector("p");
  const messageChunks = assistantRevealChunks(turn.message);
  if (messageParagraph && messageChunks.length > 0) {
    messageParagraph.classList.remove("assistant-reveal-hidden");
    messageParagraph.classList.add("assistant-reveal-text");
    messageParagraph.innerHTML = messageChunks
      .map((chunk) => `<span class="assistant-reveal-fragment">${escapeHtml(chunk).replaceAll("\n", "<br />")}</span>`)
      .join("");
  }

  const chip = assistantTurn.querySelector(".topic-chip");
  const reason = nodes.center.querySelector(`.conversation-reason[data-parent-turn-key="${turnKey}"]`);
  const revealItems = [
    ...assistantTurn.querySelectorAll(".assistant-reveal-fragment"),
    chip,
    reason
  ].filter(Boolean);

  if (revealItems.length === 0) return;

  const stagger = Math.min(82, Math.max(42, Math.floor(1050 / revealItems.length)));
  revealItems.forEach((item, index) => {
    item.classList.remove("assistant-reveal-hidden");
    item.classList.add("assistant-reveal-item");
    const timerId = window.setTimeout(() => item.classList.add("is-visible"), index * stagger);
    assistantRevealTimerIds.push(timerId);
  });

  assistantTurn.classList.remove("assistant-reveal-pending");
}

function revealCenterSelection() {
  clearSelectionRevealTimers();
  state.selectionRevealPending = false;

  const selection = nodes.center.querySelector(".center-selection");
  const options = [...(selection?.querySelectorAll(".center-option-reveal-pending") ?? [])];
  if (!selection || options.length === 0) return;

  const stagger = Math.min(90, Math.max(55, Math.floor(420 / options.length)));
  options.forEach((option, index) => {
    option.classList.remove("center-option-reveal-pending");
    option.classList.add("center-option-reveal-item");
    if (index === 0) {
      option.classList.add("is-visible");
      return;
    }
    const timerId = window.setTimeout(() => option.classList.add("is-visible"), index * stagger);
    selectionRevealTimerIds.push(timerId);
  });
}

function revealRightPanel() {
  clearRightRevealTimers();
  state.rightRevealPending = false;

  const surface = nodes.right.querySelector(".right-content-reveal-pending");
  const items = [...(surface?.children ?? [])];
  if (!surface || items.length === 0) return;

  surface.classList.remove("right-content-reveal-pending");
  const stagger = Math.min(90, Math.max(55, Math.floor(420 / items.length)));
  items.forEach((item, index) => {
    item.classList.add("right-content-reveal-item");
    if (index === 0) {
      item.classList.add("is-visible");
      return;
    }
    const timerId = window.setTimeout(() => item.classList.add("is-visible"), index * stagger);
    rightRevealTimerIds.push(timerId);
  });
}

async function stopGeneration() {
  if (state.mode === "brunch-chat") {
    const chat = state.brunchChat;
    if (!chat.isLoading) return;
    const controller = generationAbortController;
    const generationId = chat.generationId;
    try {
      if (generationId) await codexProvider.abortBrunchChat({ sessionId: chat.sessionId, generationId });
    } catch (error) {
      controller?.abort();
      generationAbortController = null;
      clearGenerationTimer();
      chat.messages = brunchChatPendingMessages ?? chat.messages;
      chat.isLoading = false;
      chat.generationState = "resting";
      chat.generationId = null;
      brunchChatPendingMessages = null;
      state.generatingElapsedSeconds = 0;
      chat.error = error?.code === "network_unavailable"
        ? copyCatalog.brunchChat.networkError
        : error instanceof Error ? error.message : copyCatalog.brunchChat.error;
      renderApp();
      return;
    }
    controller?.abort();
    generationAbortController = null;
    clearGenerationTimer();
    chat.messages = brunchChatPendingMessages ?? chat.messages;
    chat.isLoading = false;
    chat.generationState = "resting";
    chat.generationId = null;
    chat.error = null;
    brunchChatPendingMessages = null;
    state.generatingElapsedSeconds = 0;
    renderApp();
    return;
  }
  if (!state.isGenerating || !generationAbortController) return;

  generationAbortController.abort();
  generationAbortController = null;
  clearGenerationTimer();
  state.isGenerating = false;
  state.generatingElapsedSeconds = 0;
  state.pendingTurn = null;
  state.forceHistorySelection = true;
  appendConversationTurn(interruptedConversationTurn(currentViewModel()));
  state.conversationScrollTarget = "latest-user";
  clearWorkflowNotice();
  renderApp();
}

function buildRespondRequest() {
  const viewModel = currentViewModel();
  const isStart = state.timeline.responses.length === 0;
  const currentStep = isStart ? "track_selection" : viewModel.step;
  const freeRevise = freeReviseValue();
  const selected = selectedOptionId(viewModel);
  const targetStep = currentStep === "publish_package_review"
    ? currentStep
    : getSubmitTargetStep({
      isStart,
      currentStep,
      freeRevise,
      selectedOptionId: selected
    });

  const isV04 = state.timeline.workflowKind !== "fixture" && (isStart || viewModel.schemaVersion === "0.4" || viewModel.raw?.route === "new_content");
  const isDraftRecoveryAction = currentStep === "draft_review" && ["start_claim_research", "retry_claim_research", "attach_claim_research", "recheck_draft"].includes(selected);
  const sourceSelectionActive = isV04 && viewModel.step === "source_selection";
  const sourceSelection = viewModel.ui.source_selection ?? state.timeline.accumulated?.source_selection ?? {};
  const selectedSourceSelection = sourceSelectionActive ? selectedSourceIdsWithHiddenPreserved(sourceSelection) : { selected_document_ids: [], selected_evidence_ids: [] };
  const selectedDocumentIds = selectedSourceSelection.selected_document_ids;
  const selectedEvidenceIds = selectedSourceSelection.selected_evidence_ids;
  const selectedResearchSourceIds = selectedSourceSelection.selected_research_source_ids;
  const evidenceRecords = [
    ...(sourceSelection.research_evidence ?? []),
    ...(sourceSelection.selected_evidence ?? [])
  ];
  const selectableEvidenceIds = new Set(evidenceRecords
    .filter((item) => isResearchEvidenceSelectable(item))
    .map((item) => item.evidence_id ?? item.id));
  const hasEvidenceRecords = evidenceRecords.length > 0;
  const sourceSelectionForProvider = sourceSelectionActive
    ? {
        ...sourceSelection,
        selected_document_ids: selectedDocumentIds,
        selected_evidence_ids: selectedEvidenceIds,
        selected_research_source_ids: selectedResearchSourceIds,
        ...mergeSelectedSourceRecords(
          sourceSelection,
          sourceSelection.knowledge_documents ?? [],
          evidenceRecords,
          selectedDocumentIds,
          selectedEvidenceIds,
          selectedResearchSourceIds
        )
      }
    : null;

  const compactResponseForProvider = (response, { preserveDraft = false, sourceSelectionOverride = null } = {}) => {
    if (!response || typeof response !== "object") return null;
    const ui = response.ui ?? {};
    const compactUi = {
      component: ui.component,
      title: ui.title,
      description: ui.description,
      options: (ui.options ?? []).map((option) => ({
        id: option.id,
        title: option.title,
        description: option.description,
        tags: option.tags,
        document_ids: option.document_ids,
        evidence_ids: option.evidence_ids
      })),
      sections: (ui.sections ?? []).map((section) => ({
        id: section.id,
        title: section.title,
        summary: section.summary,
        bullets: section.bullets,
        document_ids: section.document_ids,
        evidence_ids: section.evidence_ids,
        metadata: section.metadata
      }))
    };
    if (ui.source_selection) {
      compactUi.source_selection = compactSourceSelectionForProvider(
        sourceSelectionOverride && response === viewModel.raw ? sourceSelectionOverride : ui.source_selection
      );
    }
    if (preserveDraft && ui.draft) {
      compactUi.draft = {
        id: ui.draft.id,
        title: ui.draft.title,
        subtitle: ui.draft.subtitle,
        body_markdown: ui.draft.body_markdown,
        metadata: ui.draft.metadata,
        provenance: ui.draft.provenance
      };
    }
    return {
      schema_version: response.schema_version,
      route: response.route,
      step: response.step,
      message: response.message,
      ui: compactUi,
      recommendation: response.recommendation,
      state_patch: {
        ...(response.state_patch ?? {}),
        source_selection: response.state_patch?.source_selection
          ? compactSourceSelectionForProvider(response.state_patch.source_selection)
          : undefined,
        metadata: {
          ...(response.state_patch?.metadata ?? {}),
          source_selection_context: response.state_patch?.metadata?.source_selection_context
            ? compactSourceSelectionForProvider(response.state_patch.metadata.source_selection_context)
            : undefined
        }
      }
    };
  };
  const compactAccumulatedState = {
    ...state.timeline.accumulated,
    source_selection: sourceSelectionForProvider
      ? compactSourceSelectionForProvider(sourceSelectionForProvider)
      : state.timeline.accumulated?.source_selection
        ? compactSourceSelectionForProvider(state.timeline.accumulated.source_selection)
      : undefined,
    metadata: {
      ...(state.timeline.accumulated?.metadata ?? {}),
      knowledge_context: undefined,
      research_context: undefined,
      source_selection_context: undefined
    }
  };
  const recoveryState = {
    target_track: state.timeline.accumulated?.target_track,
    target_channel: state.timeline.accumulated?.target_channel,
    content_purpose: state.timeline.accumulated?.content_purpose,
    purpose_confirmed: state.timeline.accumulated?.purpose_confirmed,
    selected_topic_id: state.timeline.accumulated?.selected_topic_id,
    selected_angle_id: state.timeline.accumulated?.selected_angle_id,
    selected_document_ids: state.timeline.accumulated?.selected_document_ids ?? [],
    selected_evidence_ids: state.timeline.accumulated?.selected_evidence_ids ?? [],
    claim_research_job_id: state.timeline.accumulated?.claim_research_job_id
      ?? viewModel.raw?.state_patch?.metadata?.claim_research_request?.job_id
      ?? null
  };

  return {
    ...(isV04 ? { schema_version: "0.4", route: "new_content" } : { schema_version: "0.3" }),
    workflow_session_id: state.timeline.workflowSessionId,
    workflow_kind: state.timeline.workflowKind ?? "live",
    turn_id: createWorkflowTurnId(),
    mode: isStart ? "start" : "next",
    target_step: targetStep,
    current_step: currentStep,
    responses: isDraftRecoveryAction ? [] : state.timeline.responses.map((response) => compactResponseForProvider(response, { preserveDraft: targetStep === "publish_package_review" && response.step === "draft_review" })).filter(Boolean),
    state: isDraftRecoveryAction ? recoveryState : compactAccumulatedState,
    selected_option_id: selected,
    selected_document_ids: sourceSelectionActive ? selectedDocumentIds : selectedDocumentIds.length ? selectedDocumentIds : state.timeline.accumulated?.selected_document_ids ?? [],
    selected_evidence_ids: sourceSelectionActive
      ? selectedEvidenceIds.filter((id) => selectableEvidenceIds.has(id))
      : (selectedEvidenceIds.length ? selectedEvidenceIds : state.timeline.accumulated?.selected_evidence_ids ?? []).filter((id) => !hasEvidenceRecords || selectableEvidenceIds.has(id)),
    selected_research_source_ids: sourceSelectionActive
      ? selectedResearchSourceIds
      : state.timeline.accumulated?.selected_research_source_ids ?? [],
    free_revise: freeRevise,
    ...(viewModel.step === "draft_review" && viewModel.raw?.ui?.draft?.metadata?.edited_locally ? { edited_body_markdown: viewModel.raw.ui.draft.body_markdown } : {}),
    current_response: isDraftRecoveryAction || isStart ? null : compactResponseForProvider(viewModel.raw, {
      preserveDraft: targetStep === "publish_package_review" && viewModel.step === "draft_review",
      sourceSelectionOverride: sourceSelectionForProvider
    })
  };
}

function requestSignature(request) {
  return JSON.stringify({
    mode: request.mode,
    current_step: request.current_step,
    target_step: request.target_step,
    selected_option_id: request.selected_option_id,
    free_revise: request.free_revise,
    current_response_step: request.current_response?.step,
    current_response_state: request.current_response?.state_patch
  });
}

function sanitizeDownloadName(value) {
  return String(value || "oz-inblog-package")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function downloadFinalPackage(viewModel) {
  const body = String(viewModel.ui.package?.body_markdown ?? "").trim();
  if (!body) return false;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeDownloadName(viewModel.ui.package?.title)}.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function isPackageApprovalOption(optionId) {
  return /(?:approve|publish|complete|finish).*package|package.*(?:approve|publish|complete|finish)/i.test(String(optionId ?? ""));
}

async function completePackageWorkflow(viewModel) {
  state.workflowCompleted = true;
  state.forceHistorySelection = false;
  try {
    const pkg = viewModel.ui.package;
    const packageMetadata = pkg.metadata ?? {};
    const selectedDocumentIds = viewModel.stateSummary.selected_document_ids ?? packageMetadata.selected_document_ids ?? [];
    const selectedEvidenceIds = viewModel.stateSummary.selected_evidence_ids ?? packageMetadata.selected_evidence_ids ?? [];
    const usedDocumentIds = viewModel.stateSummary.used_document_ids ?? packageMetadata.used_document_ids ?? selectedDocumentIds;
    const usedEvidenceIds = viewModel.stateSummary.used_evidence_ids ?? packageMetadata.used_evidence_ids ?? selectedEvidenceIds;
    const workflowSessionId = viewModel.stateSummary.workflow_session_id ?? state.timeline.workflowSessionId;
    const targetChannel = viewModel.stateSummary.target_track === "official_inblog" ? "inblog" : viewModel.stateSummary.target_channel ?? viewModel.stateSummary.target_track;
    const packageMetadataForInbox = {
      workflow_session_id: workflowSessionId,
      schema_version: viewModel.schemaVersion ?? "0.4",
      content_purpose: packageMetadata.content_purpose ?? viewModel.stateSummary.content_purpose ?? null,
      target_channel: targetChannel,
      selected_document_ids: selectedDocumentIds,
      selected_evidence_ids: selectedEvidenceIds,
      used_document_ids: usedDocumentIds,
      used_evidence_ids: usedEvidenceIds,
      source_document_ids: selectedDocumentIds,
      source_evidence_ids: selectedEvidenceIds,
      provenance: pkg.provenance ?? packageMetadata.provenance ?? [],
      created_at: new Date().toISOString(),
      fact_check_required: (pkg.fact_check_items ?? []).some((item) => item.checked !== true),
      cta_policy: viewModel.stateSummary.target_track === "brunch" ? "none" : "natural"
    };
    const draft = { id: pkg.id, title: pkg.title, subtitle: pkg.subtitle, body_markdown: pkg.body_markdown };
    const validationResponse = await fetch("/api/knowledge/inbox/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft, metadata: { ...packageMetadataForInbox, review_status: "approved" } })
    });
    const validationPayload = await validationResponse.json();
    const reviewStatus = validationPayload.status === "approved" ? "approved" : "needs_review";
    const response = await fetch("/api/knowledge/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft,
        metadata: {
          ...packageMetadataForInbox,
          review_status: reviewStatus
        }
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "초안을 Inbox에 저장하지 못했습니다.");
    downloadFinalPackage(viewModel);
    const statusLabel = reviewStatus === "approved" ? "승인 상태" : "검수 필요 상태";
    setWorkflowNotice("success", `최종 패키지를 ${statusLabel}로 markdown_sources/00-inbox에 저장했습니다: ${payload.source}`);
  } catch (error) {
    state.workflowCompleted = false;
    setWorkflowNotice("error", `패키지 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
  }
  renderApp();
}

async function continueWorkflow() {
  if (state.isGenerating) return;

  let controller = null;
  let assistantTurnToReveal = null;

  const viewModel = currentViewModel();
  if (viewModel.step === "source_selection" && state.sourceSelectionSavePending) return;
  const selected = selectedOptionId(viewModel);
  if (viewModel.step === "publish_package_review" && isPackageApprovalOption(selected) && !supportedDeterministicRuntimeVersions.has(viewModel.raw?.state_patch?.metadata?.runtime_version)) {
    await completePackageWorkflow(viewModel);
    return;
  }

  if (!providerStatus.isConnected()) {
    setWorkflowNotice("error", "Codex 연결 후 작업을 시작할 수 있습니다.");
    renderApp();
    return;
  }

  const request = buildRespondRequest();
  const signature = requestSignature(request);
  const isRetryAfterSameFailure = state.lastFailedRequestSignature === signature;

  if (!request.target_step) {
    setWorkflowNotice("info", "최종 단계입니다. Debug JSON에서 최종 패키지 응답을 확인할 수 있습니다.");
    renderApp();
    return;
  }

  try {
    if (!isRetryAfterSameFailure) {
      appendConversationTurn(userTurnFromRequest(request, viewModel));
    }
    state.isGenerating = true;
    state.pendingTurn = pendingTurnFromRequest(request);
    state.conversationScrollTarget = "latest-user";
    controller = new AbortController();
    generationAbortController = controller;
    clearWorkflowNotice();
    startGenerationTimer();
    renderApp();

    const payload = await codexProvider.respond(request, { signal: controller.signal });
    if (generationAbortController !== controller) return;
    assistantTurnToReveal = applyProviderResponse(payload, request);
    const claimResearchRequest = payload.response?.state_patch?.metadata?.claim_research_request
      ?? payload.response?.ui?.draft?.metadata?.claim_research_request;
    if (claimResearchRequest?.job_id && ["pending", "running", "research_running"].includes(claimResearchRequest.status)) {
      startClaimResearchPolling(claimResearchRequest.job_id);
    }
  } catch (error) {
    if (controller?.signal.aborted) return;
    const message = error instanceof Error ? error.message : "Unknown Codex respond error";
    state.lastFailedRequestSignature = signature;
    setWorkflowNotice("error", `생성 실패: ${message}`);
  } finally {
    if (!generationAbortController) return;
    generationAbortController = null;
    clearGenerationTimer();
    state.isGenerating = false;
    state.generatingElapsedSeconds = 0;
    state.pendingTurn = null;
    state.conversationScrollTarget = "latest-user";
    renderApp();
    if (assistantTurnToReveal) {
      revealAssistantResponse(assistantTurnToReveal.turnKey, assistantTurnToReveal);
      revealCenterSelection();
      revealRightPanel();
    }
  }
}


function toggleWorkflowRail(event) {
  event?.stopPropagation();
  document.body.classList.toggle("workflow-rail-open");
}

function closeWorkflowRailOnOutsideClick(event) {
  if (window.innerWidth > 1280) return;
  if (!document.body.classList.contains("workflow-rail-open")) return;

  const target = event.target;
  if (nodes.left?.contains(target) || nodes.workflowToggle?.contains(target)) return;

  document.body.classList.remove("workflow-rail-open");
}

function closeWorkflowRailOnEscape(event) {
  if (event.key === "Escape") {
    document.body.classList.remove("workflow-rail-open");
  }
}

function loadFigmaCaptureForDevelopment() {
  if (new URLSearchParams(window.location.search).get("figma-capture") !== "1") return;
  if (document.querySelector('script[data-figma-capture="true"]')) return;
  const script = document.createElement("script");
  script.dataset.figmaCapture = "true";
  script.src = "https://mcp.figma.com/mcp/html-to-design/capture.js";
  script.async = true;
  document.head.appendChild(script);
}

function writingReadinessLabel(readiness) {
  const copy = copyCatalog.brunchChat.readiness;
  if (readiness?.status === "evaluating") return copy.evaluating;
  if (readiness?.status === "failed") return copy.failed;
  if (readiness?.status === "stale") return copy.stale;
  if (readiness?.band === "needs_work") return copy.needsWork;
  if (readiness?.band === "almost_ready") return copy.almostReady;
  if (readiness?.band === "ready") return copy.ready;
  return copy.pending;
}

function writingReadinessBandIconClass(readiness) {
  const band = readiness?.band ?? readiness?.status;
  return ["ready", "almost_ready"].includes(band) ? "check-icon" : "warn-icon";
}

function writingReadinessScoreMarkup(score, scoreLabel = "") {
  const normalized = Math.max(0, Math.min(5, Number.parseInt(score, 10) || 0));
  const visibleScore = `${normalized}${scoreLabel}`;
  return `<span class="writing-readiness-score" role="img" aria-label="${escapeHtml(visibleScore)}">${Array.from({ length: 5 }, (_, index) => `<span class="writing-readiness-score-dot${index < normalized ? " is-filled" : ""}" aria-hidden="true"></span>`).join("")}<span class="writing-readiness-score-value" aria-hidden="true">${escapeHtml(visibleScore)}</span></span>`;
}

function renderWritingReadinessDetail(modal, readiness) {
  const panel = modal?.querySelector("[data-writing-readiness]");
  if (!panel) return;
  const shell = modal.querySelector(".writing-editor-modal-shell");
  shell?.classList.toggle("has-readiness", Boolean(readiness));
  if (!readiness) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const copy = copyCatalog.brunchChat.readiness;
  const dimensions = Array.isArray(readiness.dimensions) ? readiness.dimensions : [];
  const labels = copy.dimensionLabels ?? {};
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.slice(0, 2) : [];
  const summary = readiness.summary || copy.summaryFallback;
  const retry = ["stale", "failed"].includes(readiness.status)
    ? `<button type="button" class="writing-readiness-detail-retry" data-readiness-retry="${escapeHtml(modal?.dataset.chatMessageIndex ?? "")}">${escapeHtml(copy.retry)}</button>`
    : "";
  panel.hidden = false;
  panel.innerHTML = `<div class="writing-readiness-detail-head"><span class="writing-readiness-detail-caption">${escapeHtml(copy.detailStatusCaption)}</span><div class="writing-readiness-detail-band-row"><span class="writing-readiness-detail-band-icon ${writingReadinessBandIconClass(readiness)}" aria-hidden="true"></span><strong class="writing-readiness-detail-band">${escapeHtml(writingReadinessLabel(readiness))}</strong></div>${readiness.status === "evaluating" ? '<span class="writing-readiness-detail-spinner" aria-hidden="true"></span>' : ""}</div>
    <div class="writing-readiness-detail-reason"><span class="writing-readiness-detail-caption">${escapeHtml(copy.detailReasonCaption)}</span><p>${escapeHtml(summary)}</p></div>
    ${dimensions.length ? `<div class="writing-readiness-detail-section"><span class="writing-readiness-detail-caption">${escapeHtml(copy.detailDimensionsCaption)}</span><div class="writing-readiness-detail-dimensions" aria-label="${escapeHtml(copy.dimensions)}">${dimensions.map((dimension) => `<div class="writing-readiness-detail-dimension"><strong>${escapeHtml(labels[dimension.id] ?? dimension.id)}</strong>${writingReadinessScoreMarkup(dimension.score, copy.score)}</div>`).join("")}</div></div>` : ""}
    ${blockers.length ? `<div class="writing-readiness-detail-section writing-readiness-detail-blocker-section"><span class="writing-readiness-detail-caption">${escapeHtml(copy.detailBlockersCaption)}</span><ul class="writing-readiness-detail-blockers">${blockers.map((blocker) => `<li>${escapeHtml(blocker.action ?? blocker.message ?? "")}</li>`).join("")}</ul></div>` : ""}
    ${retry}`;
}

function refreshWritingEditorReadiness() {
  const modal = document.querySelector("#writingEditorModal");
  if (!modal || modal.hidden || state.mode !== "brunch-chat") return;
  const messageIndex = Number(modal.dataset.chatMessageIndex);
  renderWritingReadinessDetail(modal, state.brunchChat.messageMeta?.[String(messageIndex)]?.readiness ?? null);
}

async function hashWritingEditorMarkdown(markdown) {
  const bytes = new TextEncoder().encode(String(markdown ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function boot() {
  loadFigmaCaptureForDevelopment();
function splitMarkdownIntoParagraphs(markdown) {
  return String(markdown || "")
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function writingEditorCanvas(modal = document.querySelector("#writingEditorModal")) {
  return modal?.querySelector(".writing-editor-canvas") ?? null;
}

function writingEditorSource(modal = document.querySelector("#writingEditorModal")) {
  return modal?.querySelector(".writing-editor-source") ?? null;
}

function setWritingEditorMarkdown(modal, markdown) {
  const value = String(markdown ?? "");
  const source = writingEditorSource(modal);
  const canvas = writingEditorCanvas(modal);
  if (source) source.value = value;
  if (canvas) canvas.innerHTML = markdownToEditorHtml(value);
}

function syncWritingEditorSource(modal = document.querySelector("#writingEditorModal")) {
  const source = writingEditorSource(modal);
  const canvas = writingEditorCanvas(modal);
  if (!source || !canvas) return source?.value ?? "";
  source.value = editorHtmlToMarkdown(canvas);
  return source.value;
}

function syncWritingEditorOverlayInsets(modal = document.querySelector("#writingEditorModal")) {
  if (!modal || state.mode !== "brunch-chat") return;
  const canvas = writingEditorCanvas(modal);
  const header = modal.querySelector(".writing-editor-header");
  const chat = modal.querySelector(".writing-editor-chat");
  if (!canvas || !header || !chat) return;
  canvas.style.setProperty("--writing-editor-header-height", `${header.getBoundingClientRect().height}px`);
  canvas.style.setProperty("--writing-editor-chat-height", `${chat.getBoundingClientRect().height}px`);
}

function sanitizeFileName(value) {
  return String(value || "writing")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function ensureWritingEditor() {
  let modal = document.querySelector("#writingEditorModal");
  if (modal) return modal;

  const isBrunchChat = state.mode === "brunch-chat";
  const brunchWritingHeader = isBrunchChat
    ? `<div class="writing-editor-header-main writing-editor-header-main-brunch">
        <h2 id="writing-editor-title" data-writing-editor-title>${escapeHtml(copyCatalog.writing.title)}</h2>
      </div>
      <nav class="writing-editor-version-options writing-editor-tone-options" data-writing-version-options aria-label="${escapeHtml(copyCatalog.writing.versionOptionsLabel)}" role="group" hidden></nav>`
    : `<div>
        <p class="writing-editor-eyebrow">${escapeHtml(copyCatalog.writing.eyebrow)}</p>
        <h2 id="writing-editor-title" data-writing-editor-title>${escapeHtml(copyCatalog.writing.title)}</h2>
      </div>`;

  modal = document.createElement("div");
  modal.id = "writingEditorModal";
  modal.className = "writing-editor-backdrop";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="writing-editor-modal-shell" role="dialog" aria-modal="true" aria-labelledby="writing-editor-title">
      <section class="writing-readiness-detail writing-readiness-sidecar" data-writing-readiness hidden aria-label="${escapeHtml(copyCatalog.brunchChat.readiness.dimensions)}" aria-live="polite"></section>
      <div class="writing-editor-modal">
        <header class="writing-editor-header${isBrunchChat ? " writing-editor-header-brunch" : ""}">
          ${brunchWritingHeader}
          <div class="writing-editor-tools">
            <div class="writing-editor-tool-group">
              ${isBrunchChat
                ? `<button type="button" class="writing-editor-icon-button" data-writing-copy aria-label="${escapeHtml(copyCatalog.writing.copy)}" title="${escapeHtml(copyCatalog.writing.copy)}"><img src="/assets/Copy.svg" width="16" height="16" alt="" /></button>`
                : `<button type="button" data-writing-copy>${escapeHtml(copyCatalog.writing.copy)}</button>`}
              <button type="button" data-writing-download>${escapeHtml(copyCatalog.writing.exportMarkdown)}</button>
            </div>
            <button type="button" class="writing-editor-close" data-writing-close aria-label="${escapeHtml(copyCatalog.writing.close)}">
              ${isBrunchChat ? '<span class="writing-editor-close-icon" aria-hidden="true"></span>' : escapeHtml(copyCatalog.writing.close)}
            </button>
          </div>
        </header>

        <textarea class="writing-editor-source" tabindex="-1" aria-hidden="true" hidden></textarea>
        <div class="writing-editor-textarea writing-editor-canvas markdown-preview" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${escapeHtml(copyCatalog.writing.title)}" spellcheck="false"></div>

        <section class="writing-editor-chat">
          <div class="writing-quick-actions">
            <span data-writing-skill-actions></span>
            <button type="button" data-writing-prompt="${escapeHtml(copyCatalog.writing.sentenceConcisePrompt)}">${escapeHtml(copyCatalog.writing.sentenceConcise)}</button>
            <button type="button" data-writing-prompt="${escapeHtml(copyCatalog.writing.paragraphFlowPrompt)}">${escapeHtml(copyCatalog.writing.paragraphFlow)}</button>
            <button type="button" data-writing-prompt="${escapeHtml(copyCatalog.writing.brunchTonePrompt)}">${escapeHtml(copyCatalog.writing.brunchTone)}</button>
            <button type="button" data-writing-prompt="${escapeHtml(copyCatalog.writing.introStrengthenPrompt)}">${escapeHtml(copyCatalog.writing.introStrengthen)}</button>
            <button type="button" data-writing-prompt="${escapeHtml(copyCatalog.writing.conclusionStrengthenPrompt)}">${escapeHtml(copyCatalog.writing.conclusionStrengthen)}</button>
          </div>

          <div class="writing-chat-row${isBrunchChat ? " writing-editor-chatbox" : ""}">
            <input type="text" data-writing-request placeholder="${escapeHtml(copyCatalog.writing.requestPlaceholder)}" aria-label="${escapeHtml(copyCatalog.writing.requestPlaceholder)}" />
            <button type="button" class="writing-editor-chatbox-submit" data-writing-ai-request aria-label="${escapeHtml(copyCatalog.writing.askAi)}">
              ${isBrunchChat ? '<img src="/assets/ChatArrowDisabled.svg" width="18" height="18" alt="" />' : escapeHtml(copyCatalog.writing.askAi)}
            </button>
            ${isBrunchChat ? "" : `<button type="button" class="primary" data-writing-apply>${escapeHtml(copyCatalog.writing.apply)}</button>`}
          </div>
          <p class="writing-editor-status" data-writing-status role="status" aria-live="polite"></p>
        </section>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.addEventListener("click", (event) => {
    if (event.target !== modal) return;
    event.stopPropagation();
    if (!writingEditorLocked(modal)) closeWritingEditor();
  });
  if (isBrunchChat) {
    modal.querySelector("[data-writing-request]")?.addEventListener("input", () => syncWritingEditorChatbox(modal));
  }
  const canvas = writingEditorCanvas(modal);
  canvas?.addEventListener("compositionstart", () => {
    modal.dataset.writingComposing = "true";
  });
  canvas?.addEventListener("compositionend", () => {
    modal.dataset.writingComposing = "false";
    if (writingEditorLocked(modal)) return;
    applyMarkdownShortcut(canvas);
    syncWritingEditorSource(modal);
    modal.dataset.writingDirty = "true";
  });
  canvas?.addEventListener("input", () => {
    if (writingEditorLocked(modal) || modal.dataset.writingComposing === "true") return;
    applyMarkdownShortcut(canvas);
    syncWritingEditorSource(modal);
    modal.dataset.writingDirty = "true";
  });
  renderWritingSkillButtons(modal);
  if (isBrunchChat) {
    const header = modal.querySelector(".writing-editor-header");
    const chat = modal.querySelector(".writing-editor-chat");
    if (typeof ResizeObserver === "function" && header && chat) {
      const observer = new ResizeObserver(() => syncWritingEditorOverlayInsets(modal));
      observer.observe(header);
      observer.observe(chat);
      modal._writingEditorOverlayObserver = observer;
    }
  }
  return modal;
}

function writingVersionLabel(summary, index) {
  if (typeof summary?.label === "string" && summary.label.trim()) return summary.label.trim();
  return ["원본", "수정됨", "문단 정리됨"][index] ?? `수정본 ${index + 1}`;
}

function writingEditorVersionSummaries(modal = document.querySelector("#writingEditorModal")) {
  const index = Number(modal?.dataset.chatMessageIndex);
  if (!Number.isInteger(index)) return [];
  return Array.isArray(state.brunchChat.messageMeta?.[String(index)]?.versionSummaries)
    ? state.brunchChat.messageMeta[String(index)].versionSummaries
    : [];
}

function renderWritingEditorVersions(modal = document.querySelector("#writingEditorModal")) {
  const options = modal?.querySelector("[data-writing-version-options]");
  if (!options) return;
  const summaries = writingEditorVersionSummaries(modal);
  if (summaries.length < 3) {
    options.hidden = true;
    options.replaceChildren();
    return;
  }
  const currentVersionId = modal.dataset.chatVersionId || state.brunchChat.messageMeta?.[String(modal.dataset.chatMessageIndex)]?.versionId || "";
  options.hidden = false;
  options.innerHTML = summaries.map((summary, index) => {
    const selected = summary.versionId === currentVersionId || (summary.active && !currentVersionId);
    return `<button type="button" class="writing-editor-version-option writing-editor-tone-option${selected ? " is-selected" : ""}" data-writing-version-id="${escapeHtml(summary.versionId ?? "")}" aria-pressed="${String(selected)}"${writingEditorLocked(modal) ? " disabled" : ""}>${escapeHtml(writingVersionLabel(summary, index))}</button>`;
  }).join("");
}

function renderWritingSkillButtons(modal = ensureWritingEditor()) {
  const container = modal.querySelector("[data-writing-skill-actions]");
  if (!container) return;
  const skills = state.mode === "brunch-chat" && Array.isArray(state.brunchChat.writingSkills)
    ? state.brunchChat.writingSkills
    : [];
  container.innerHTML = skills.map((skill) => `<button type="button" class="writing-skill-action" data-writing-skill-id="${escapeHtml(skill.id)}">${escapeHtml(skill.label)}</button>`).join("");
  container.querySelectorAll("[data-writing-skill-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      applyWritingSkillPrompt(button, modal);
    });
  });
}

function applyWritingSkillPrompt(button, modal = ensureWritingEditor()) {
  if (writingEditorLocked(modal)) return;
  const input = modal.querySelector("[data-writing-request]");
  const skill = state.brunchChat.writingSkills?.find((entry) => entry.id === button.dataset.writingSkillId)
    ?? { id: button.dataset.writingSkillId, label: button.textContent.trim() };
  if (!input || !skill.label) return;
  const current = input.value.trim().replace(/^\$[^\s]+\s*/u, "");
  input.value = `$${skill.label}${current ? ` ${current}` : " "}`;
  syncWritingEditorChatbox(modal);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function setWritingEditorStatus(message = "", { error = false } = {}) {
  const status = document.querySelector("#writingEditorModal [data-writing-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", error);
}

function writingEditorPhase(modal = document.querySelector("#writingEditorModal")) {
  return modal?.dataset.phase || "editing";
}

function writingEditorLocked(modal = document.querySelector("#writingEditorModal")) {
  return ["refining", "saving"].includes(writingEditorPhase(modal));
}

function syncWritingEditorChatbox(modal = document.querySelector("#writingEditorModal")) {
  const isBrunchChatModal = modal?.dataset.chatMessageIndex !== undefined && modal?.dataset.chatMessageIndex !== "";
  if (!modal || (state.mode !== "brunch-chat" && !isBrunchChatModal)) return;
  const input = modal.querySelector("[data-writing-request]");
  const button = modal.querySelector("[data-writing-ai-request]");
  if (!input || !button) return;
  const phase = writingEditorPhase(modal);
  const isThinking = phase === "refining" || phase === "saving";
  const hasDraft = Boolean(String(input.value ?? "").trim());
  const buttonState = isThinking ? "thinking" : hasDraft ? "typing" : "resting";
  const iconName = buttonState === "thinking"
    ? "ChatThinking.svg"
    : buttonState === "typing"
      ? "ChatArrowActive.svg"
      : "ChatArrowDisabled.svg";
  button.classList.remove("is-active", "is-thinking", "is-disabled", "is-resting", "is-typing");
  button.classList.add(`is-${buttonState}`);
  button.disabled = isThinking || !hasDraft;
  button.setAttribute("aria-disabled", String(button.disabled));
  button.querySelector("img")?.setAttribute("src", `/assets/${iconName}`);
  input.placeholder = isThinking ? copyCatalog.writing.thinkingPlaceholder : copyCatalog.writing.requestPlaceholder;
}

function setWritingEditorTone(tone = "default", modal = ensureWritingEditor()) {
  const allowed = new Set(["default", "short", "provocative"]);
  const nextTone = allowed.has(tone) ? tone : "default";
  modal.dataset.writingTone = nextTone;
  modal.querySelectorAll("[data-writing-tone]").forEach((button) => {
    const selected = button.dataset.writingTone === nextTone;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function writingEditorToneInstruction(modal = ensureWritingEditor()) {
  const tone = modal.dataset.writingTone || "default";
  if (tone === "short") return `문체 옵션은 ${copyCatalog.writing.toneShort}입니다.`;
  if (tone === "provocative") return `문체 옵션은 ${copyCatalog.writing.toneProvocative}입니다.`;
  return "";
}

function resolveWritingSkillRequest(request, skills = []) {
  const value = String(request ?? "").trim();
  const match = value.match(/^\$([^\s]+)(?:\s+([\s\S]*))?$/u);
  if (!match) return { skill: null, instruction: value };
  const token = match[1].toLocaleLowerCase();
  const skill = skills.find((entry) => [entry.id, entry.label].some((candidate) => String(candidate ?? "").toLocaleLowerCase() === token)) ?? null;
  return skill ? { skill, instruction: String(match[2] ?? "").trim() } : { skill: null, instruction: value };
}

function setWritingEditorPhase(phase, modal = ensureWritingEditor()) {
  const locked = phase === "refining" || phase === "saving";
  modal.dataset.phase = phase;
  modal.dataset.saving = phase === "saving" ? "true" : "false";
  modal.classList.remove("writing-editor-editing", "writing-editor-refining", "writing-editor-saving", "writing-editor-saved", "writing-editor-error");
  modal.classList.add(`writing-editor-${phase}`);
  modal.setAttribute("aria-busy", String(locked));
  const canvas = writingEditorCanvas(modal);
  if (canvas) {
    canvas.setAttribute("contenteditable", String(!locked));
    canvas.setAttribute("aria-readonly", String(locked));
    canvas.tabIndex = locked ? -1 : 0;
  }
  modal.querySelectorAll("[data-writing-copy], [data-writing-download], [data-writing-close], [data-writing-ai-request], [data-writing-apply], [data-writing-prompt], [data-writing-skill-id], [data-writing-tone], [data-writing-version-id], [data-writing-mode-toggle], [data-writing-request]").forEach((control) => {
    control.disabled = locked;
    control.setAttribute("aria-disabled", String(locked));
  });
  renderWritingEditorVersions(modal);
  syncWritingEditorChatbox(modal);
}

function openWritingEditor({ title, content, sectionId, sourceStep, chatMessageIndex = "", chatTurnId = "", chatVersionId = "", returnFocus = null }) {
  const modal = ensureWritingEditor();
  const applyButton = modal.querySelector("[data-writing-apply]");
  if (applyButton) applyButton.hidden = state.mode === "brunch-chat";
  modal.dataset.sectionId = sectionId || "body";
  modal.dataset.sourceStep = sourceStep || currentViewModel().step;
  modal.dataset.title = title || copyCatalog.writing.title;
  modal.dataset.chatMessageIndex = String(chatMessageIndex ?? "");
  modal.dataset.chatTurnId = String(chatTurnId ?? "");
  modal.dataset.chatVersionId = String(chatVersionId ?? "");
  writingEditorReturnFocus = {
    element: returnFocus,
    selector: chatMessageIndex !== ""
      ? `[data-writing-chat-index="${String(chatMessageIndex).replaceAll('"', "\\\"")}"] [data-writing-open]`
      : null
  };

  modal.querySelector("[data-writing-editor-title]").textContent = state.mode === "brunch-chat"
    ? copyCatalog.writing.title
    : title || copyCatalog.writing.title;
  const canvas = writingEditorCanvas(modal);
  setWritingEditorMarkdown(modal, content || "");
  if (canvas) canvas.scrollTop = 0;
  modal.dataset.writingDirty = "false";
  modal.querySelector("[data-writing-request]").value = "";
  const copyButton = modal.querySelector("[data-writing-copy]");
  if (copyButton) {
    window.clearTimeout(Number(copyButton.dataset.copyFeedbackTimer || 0));
    copyButton.classList.remove("is-copied", "check-icon");
    copyButton.setAttribute("aria-label", copyCatalog.writing.copy);
    copyButton.setAttribute("title", copyCatalog.writing.copy);
    copyButton.querySelector("img")?.removeAttribute("hidden");
    delete copyButton.dataset.copyFeedbackTimer;
  }
  writingEditorPendingSave = null;
  renderWritingSkillButtons(modal);
  renderWritingEditorVersions(modal);
  renderWritingReadinessDetail(modal, state.brunchChat.messageMeta?.[String(chatMessageIndex)]?.readiness ?? null);
  setWritingEditorPhase("editing", modal);
  setWritingEditorStatus();
  modal.hidden = false;
  document.body.classList.add("writing-editor-open");
  syncWritingEditorOverlayInsets(modal);

  requestAnimationFrame(() => {
    syncWritingEditorOverlayInsets(modal);
    canvas?.focus();
    if (canvas) canvas.scrollTop = 0;
  });
}

function closeWritingEditor({ restoreFocus = true } = {}) {
  const modal = document.querySelector("#writingEditorModal");
  if (!modal) return;
  if (writingEditorLocked(modal)) return;
  if (modal.dataset.writingDirty === "true") {
    void applyWritingEditor();
    return;
  }
  modal.hidden = true;
  document.body.classList.remove("writing-editor-open");
  if (!restoreFocus) {
    writingEditorReturnFocus = null;
    return;
  }
  const returnFocus = writingEditorReturnFocus;
  writingEditorReturnFocus = null;
  requestAnimationFrame(() => {
    const target = returnFocus?.element?.isConnected
      ? returnFocus.element
      : returnFocus?.selector
        ? document.querySelector(returnFocus.selector)
        : null;
    target?.focus();
  });
}

function writingEditorValue() {
  return syncWritingEditorSource() ?? "";
}

function updateCurrentTimelineSection(sectionId, markdown) {
  const index = state.timeline.selectedIndex;
  if (index < 0) return;

  const nextResponses = state.timeline.responses.map((response, responseIndex) => {
    if (responseIndex !== index) return response;

    const nextSections = (response.ui?.sections ?? []).map((section) => {
      if (section.id !== sectionId) return section;
      return {
        ...section,
        bullets: splitMarkdownIntoParagraphs(markdown),
        metadata: {
          ...(section.metadata ?? {}),
          edited_locally: true,
          edited_at: new Date().toISOString()
        }
      };
    });

    const nextDraft = response.ui?.draft && ["draft", "body", "body_markdown"].includes(sectionId)
      ? {
        ...response.ui.draft,
        body_markdown: markdown,
        metadata: {
          ...(response.ui.draft.metadata ?? {}),
          edited_locally: true,
          edited_at: new Date().toISOString()
        }
      }
      : response.ui?.draft;

    return {
      ...response,
      ui: {
        ...response.ui,
        sections: nextSections,
        ...(nextDraft ? { draft: nextDraft } : {})
      },
      state_patch: {
        ...(response.state_patch ?? {}),
        metadata: {
          ...(response.state_patch?.metadata ?? {}),
          edited_locally: true,
          edited_section_id: sectionId,
          edited_at: new Date().toISOString()
        }
      }
    };
  });

  state.timeline = selectTimelineIndex(
    {
      ...state.timeline,
      responses: nextResponses,
      selectedResponse: nextResponses[index]
    },
    index
  );

  state.conversationTurns = conversationTurnsFromTimeline(state.timeline);
  renderApp();
}

async function copyWritingEditor() {
  await navigator.clipboard.writeText(stripBrunchSourcesForCopy(writingEditorValue()));
  const button = document.querySelector("#writingEditorModal [data-writing-copy]");
  if (!button) return;
  const icon = button.querySelector("img");
  button.classList.add("is-copied", "check-icon");
  button.setAttribute("aria-label", copyCatalog.writing.copied);
  button.setAttribute("title", copyCatalog.writing.copied);
  window.clearTimeout(Number(button.dataset.copyFeedbackTimer || 0));
  button.dataset.copyFeedbackTimer = String(window.setTimeout(() => {
    button.classList.remove("is-copied", "check-icon");
    button.setAttribute("aria-label", copyCatalog.writing.copy);
    button.setAttribute("title", copyCatalog.writing.copy);
    icon?.removeAttribute("hidden");
    delete button.dataset.copyFeedbackTimer;
  }, 2000));
}

function downloadWritingEditorMarkdown() {
  const modal = ensureWritingEditor();
  const title = modal.dataset.title || "writing";
  const blob = new Blob([stripBrunchSourcesForCopy(writingEditorValue())], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sanitizeFileName(title)}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function brunchWritingEditorTarget(modal = ensureWritingEditor()) {
  let messageIndex = Number(modal.dataset.chatMessageIndex);
  if (!Number.isInteger(messageIndex) || state.brunchChat.messages?.[messageIndex]?.role !== "assistant") {
    const expectedTurnId = modal.dataset.chatTurnId || "";
    const expectedVersionId = modal.dataset.chatVersionId || "";
    const metadataEntry = Object.entries(state.brunchChat.messageMeta ?? {}).find(([index, metadata]) => {
      const message = state.brunchChat.messages?.[Number(index)];
      return message?.role === "assistant"
        && (!expectedTurnId || metadata?.turnId === expectedTurnId)
        && (!expectedVersionId || metadata?.versionId === expectedVersionId)
        && message.content?.writing_preview;
    });
    if (metadataEntry) messageIndex = Number(metadataEntry[0]);
  }
  if (!Number.isInteger(messageIndex) || state.brunchChat.messages?.[messageIndex]?.role !== "assistant") {
    messageIndex = [...(state.brunchChat.messages ?? [])].map((message, index) => ({ message, index }))
      .reverse()
      .find(({ message }) => message.role === "assistant" && message.content?.writing_preview)?.index ?? -1;
  }
  const savedMetadata = state.brunchChat.messageMeta?.[String(messageIndex)] ?? {};
  const turnId = modal.dataset.chatTurnId || savedMetadata.turnId || undefined;
  const versionId = modal.dataset.chatVersionId || savedMetadata.versionId || undefined;
  const turn = state.brunchChat.messages?.[messageIndex];
  const preview = turn?.role === "assistant" ? turn.content?.writing_preview : null;
  if (!preview || !Number.isInteger(messageIndex)) return null;
  return { messageIndex, turnId, versionId, turn, preview };
}

async function patchBrunchWritingPreview({ closeOnSuccess = true, markdown = null, expectedMarkdownHash = null, fromRefine = false } = {}) {
  const modal = ensureWritingEditor();
  const target = brunchWritingEditorTarget(modal);
  if (!target) {
    recordBrunchWritingDebug({ type: "preview_target_missing", operation: "patch_preview" });
    setWritingEditorStatus(copyCatalog.writing.saveFailed, { error: true });
    setWritingEditorPhase("error", modal);
    return null;
  }
  if (writingEditorLocked(modal) && !fromRefine) return null;
  const nextMarkdown = markdown === null ? writingEditorValue() : String(markdown);
  const baseHash = expectedMarkdownHash ?? await hashWritingEditorMarkdown(target.preview.markdown);
  writingEditorPendingSave = { markdown: nextMarkdown, expectedMarkdownHash: baseHash, preview: target.preview };
  setWritingEditorPhase("saving", modal);
  setWritingEditorStatus(copyCatalog.writing.saving);
  recordBrunchWritingDebug({ type: "preview_patch_started", operation: "patch_preview", fromRefine, messageIndex: target.messageIndex, turnId: target.turnId ?? null, versionId: target.versionId ?? null });
  try {
    const writingPreview = await codexProvider.patchBrunchChatPreview({
      sessionId: state.brunchChat.sessionId,
      ...(target.turnId && target.versionId ? { turnId: target.turnId, versionId: target.versionId } : { assistantMessageIndex: target.messageIndex }),
      expectedMarkdownHash: baseHash,
      writing_preview: { ...target.preview, markdown: nextMarkdown }
    });
    target.turn.content = { ...target.turn.content, writing_preview: writingPreview };
    setWritingEditorMarkdown(modal, writingPreview.markdown);
    modal.dataset.writingDirty = "false";
    if (state.mode === "brunch-chat") {
      const requestInput = modal.querySelector("[data-writing-request]");
      if (requestInput) requestInput.value = "";
      const nextPreviewHash = await hashWritingEditorMarkdown(writingPreview.markdown);
      const messageIndex = target.messageIndex;
      state.brunchChat.messageMeta = {
        ...(state.brunchChat.messageMeta ?? {}),
        [String(messageIndex)]: {
          ...(state.brunchChat.messageMeta?.[String(messageIndex)] ?? {}),
          readiness: { status: "stale", previewHash: nextPreviewHash }
        }
      };
    }
    persistCurrentBrunchChat();
    writingEditorPendingSave = null;
    setWritingEditorPhase("saved", modal);
    setWritingEditorStatus(copyCatalog.writing.saved);
    recordBrunchWritingDebug({ type: "preview_patch_succeeded", operation: "patch_preview", messageIndex: target.messageIndex, turnId: target.turnId ?? null, versionId: target.versionId ?? null });
    renderApp();
    if (closeOnSuccess) {
      closeWritingEditor();
    }
    if (state.mode === "brunch-chat") void evaluateBrunchChatReadiness(target.messageIndex, { force: true });
    return writingPreview;
  } catch (error) {
    recordBrunchWritingDebug({ type: "preview_patch_failed", operation: "patch_preview", code: error?.code ?? null, status: error?.status ?? null, messageIndex: target.messageIndex, turnId: target.turnId ?? null, versionId: target.versionId ?? null });
    const message = error?.code === "network_unavailable"
      ? copyCatalog.brunchChat.networkError
      : error instanceof Error ? error.message : copyCatalog.writing.saveFailed;
    setWritingEditorPhase("error", modal);
    setWritingEditorStatus(message, { error: true });
    return null;
  }
}

async function retryBrunchWritingPreviewSave() {
  if (!writingEditorPendingSave) return null;
  const pending = writingEditorPendingSave;
  return patchBrunchWritingPreview({ closeOnSuccess: false, markdown: pending.markdown, expectedMarkdownHash: pending.expectedMarkdownHash });
}

async function refineBrunchWritingPreviewWithSkill(skillId, instruction = "") {
  const modal = ensureWritingEditor();
  const target = brunchWritingEditorTarget(modal);
  if (state.mode !== "brunch-chat" || !target || writingEditorLocked(modal)) {
    recordBrunchWritingDebug({ type: !target ? "preview_target_missing" : "refine_blocked", operation: "refine_preview", skillId: skillId ?? null });
    return null;
  }
  const originalDraft = writingEditorValue();
  const requestInput = modal.querySelector("[data-writing-request]");
  modal.dataset.writingPendingRequest = requestInput?.value ?? "";
  if (requestInput) requestInput.value = "";
  const baseHash = await hashWritingEditorMarkdown(target.preview.markdown);
  modal.dataset.writingBaseHash = baseHash;
  setWritingEditorPhase("refining", modal);
  setWritingEditorStatus(copyCatalog.writing.refining);
  recordBrunchWritingDebug({ type: "refine_dispatch_started", operation: "refine_preview", skillId, messageIndex: target.messageIndex, turnId: target.turnId ?? null, versionId: target.versionId ?? null });
  try {
    const result = await codexProvider.refineBrunchChatPreview({
      sessionId: state.brunchChat.sessionId,
      ...(target.turnId && target.versionId ? { turnId: target.turnId, versionId: target.versionId } : { assistantMessageIndex: target.messageIndex }),
      skillId,
      markdown: originalDraft,
      baseHash,
      ...(instruction ? { instruction } : {})
    });
    setWritingEditorMarkdown(modal, result.markdown);
    setWritingEditorPhase("saving", modal);
    const saved = await patchBrunchWritingPreview({ closeOnSuccess: false, markdown: result.markdown, expectedMarkdownHash: baseHash, fromRefine: true });
    if (!saved) return null;
    setWritingEditorPhase("saved", modal);
    setWritingEditorStatus(copyCatalog.writing.saved);
    return saved;
  } catch (error) {
    recordBrunchWritingDebug({ type: "refine_dispatch_failed", operation: "refine_preview", skillId, code: error?.code ?? null, status: error?.status ?? null, messageIndex: target.messageIndex, turnId: target.turnId ?? null, versionId: target.versionId ?? null });
    setWritingEditorMarkdown(modal, originalDraft);
    if (requestInput) requestInput.value = modal.dataset.writingPendingRequest ?? "";
    setWritingEditorPhase("error", modal);
    const message = error?.code === "network_unavailable"
      ? copyCatalog.brunchChat.networkError
      : error instanceof Error ? error.message : copyCatalog.writing.saveFailed;
    setWritingEditorStatus(message, { error: true });
    return null;
  }
}

async function applyWritingEditor() {
  const modal = ensureWritingEditor();
  if (writingEditorLocked(modal)) return;
  if (writingEditorPhase(modal) === "error" && writingEditorPendingSave) {
    await retryBrunchWritingPreviewSave();
    return;
  }
  if (state.mode === "brunch-chat" && modal.dataset.chatMessageIndex !== "") {
    await patchBrunchWritingPreview();
    return;
  }
  modal.dataset.writingDirty = "false";
  updateCurrentTimelineSection(modal.dataset.sectionId || "body", writingEditorValue());
  closeWritingEditor();
}

async function sendWritingEditRequestToAi() {
  const modal = ensureWritingEditor();
  const title = modal.dataset.title || "본문";
  const body = writingEditorValue();
  const request = modal.querySelector("[data-writing-request]")?.value.trim() || "이 본문을 더 자연스럽게 다듬어 주세요.";

  if (state.mode === "brunch-chat" && modal.dataset.chatMessageIndex !== "") {
    let skills = Array.isArray(state.brunchChat.writingSkills) ? state.brunchChat.writingSkills : [];
    let { skill, instruction } = resolveWritingSkillRequest(request, skills);
    if (!skill) {
      skills = await loadBrunchWritingSkills();
      renderWritingSkillButtons(modal);
      ({ skill, instruction } = resolveWritingSkillRequest(request, skills));
    }
    skill ??= skills.find((entry) => entry.id === "korean-humanizer") ?? skills[0];
    if (!skill) {
      recordBrunchWritingDebug({ type: "writing_skill_missing", operation: "refine_preview", requested: request });
      setWritingEditorStatus(copyCatalog.writing.saveFailed, { error: true });
      return;
    }
    const toneInstruction = writingEditorToneInstruction(modal);
    const userInstruction = instruction || `현재 원고를 ${skill.label} 기준으로 다듬어 주세요.`;
    await refineBrunchWritingPreviewWithSkill(skill.id, [
      `${title} 원고에 대한 추가 요청: ${userInstruction}`,
      toneInstruction
    ].filter(Boolean).join(" "));
    return;
  }

  const inputRoot = state.mode === "brunch-chat" ? getBrunchChatInputRoot() : nodes.center;
  const reviseOption = Array.from(inputRoot.querySelectorAll(".center-option")).find((button) =>
    String(button.dataset.optionId || "").includes("revise")
  );

  if (reviseOption) {
    inputRoot.querySelectorAll(".center-option").forEach((button) => button.classList.remove("selected"));
    reviseOption.classList.add("selected");

    const continueButton = inputRoot.querySelector(".continue-button");
    if (continueButton) {
      continueButton.dataset.selectedOptionId = reviseOption.dataset.optionId;
    }
  }

  const textarea = inputRoot.querySelector(".free-revise textarea");
  if (textarea) {
    textarea.value = [
      `「${title}」 섹션을 아래 요청대로 수정해 주세요.`,
      "",
      `요청: ${request}`,
      "",
      "--- 현재 편집본 ---",
      body
    ].join("\n");
    textarea.focus();
  }

  closeWritingEditor({ restoreFocus: true });
}

document.addEventListener("click", (event) => {
  const readinessRetry = event.target.closest("[data-readiness-retry]");
  if (readinessRetry) {
    const index = Number(readinessRetry.dataset.readinessRetry);
    if (Number.isInteger(index)) void evaluateBrunchChatReadiness(index, { force: true });
    return;
  }

  const editable = event.target.closest(".editable-writing-section");
  if (editable && !event.target.closest("button, a, input, textarea")) {
    openWritingEditor({
      title: editable.dataset.writingTitle,
      content: editable.dataset.writingContent,
      sectionId: editable.dataset.writingSectionId,
      sourceStep: editable.dataset.writingSourceStep,
      chatMessageIndex: editable.dataset.writingChatIndex,
      chatTurnId: editable.dataset.writingTurnId,
      chatVersionId: editable.dataset.writingVersionId,
      returnFocus: editable.querySelector("[data-writing-open]")
    });
    return;
  }

  const openButton = event.target.closest("[data-writing-open]");
  if (openButton) {
    const section = openButton.closest(".editable-writing-section");
    if (section) {
      openWritingEditor({
        title: section.dataset.writingTitle,
        content: section.dataset.writingContent,
        sectionId: section.dataset.writingSectionId,
        sourceStep: section.dataset.writingSourceStep,
        chatMessageIndex: section.dataset.writingChatIndex,
        chatTurnId: section.dataset.writingTurnId,
        chatVersionId: section.dataset.writingVersionId,
        returnFocus: openButton
      });
    }
    return;
  }

  if (event.target.closest("[data-writing-close]")) {
    closeWritingEditor();
    return;
  }

  if (event.target.closest("[data-writing-copy]")) {
    if (writingEditorLocked()) return;
    copyWritingEditor();
    return;
  }

  const writingVersion = event.target.closest("#writingEditorModal [data-writing-version-id]");
  if (writingVersion) {
    const modal = ensureWritingEditor();
    if (writingEditorLocked(modal) || brunchChatVersionActionPending) return;
    const messageIndex = Number(modal.dataset.chatMessageIndex);
    const versionId = writingVersion.dataset.writingVersionId;
    if (!Number.isInteger(messageIndex) || !versionId) return;
    const activate = () => activateBrunchChatVersion(messageIndex, versionId).then(() => {
      const nextMessage = state.brunchChat.messages?.[messageIndex];
      const nextPreview = nextMessage?.role === "assistant" ? nextMessage.content?.writing_preview : null;
      const nextMetadata = state.brunchChat.messageMeta?.[String(messageIndex)] ?? {};
      if (!nextPreview) return;
      modal.dataset.chatVersionId = nextMetadata.versionId || versionId;
      modal.dataset.writingDirty = "false";
      setWritingEditorMarkdown(modal, nextPreview.markdown);
      renderWritingEditorVersions(modal);
      renderWritingReadinessDetail(modal, nextMetadata.readiness ?? null);
      const canvas = writingEditorCanvas(modal);
      if (canvas) canvas.scrollTop = 0;
    });
    if (modal.dataset.writingDirty === "true") {
      void patchBrunchWritingPreview({ closeOnSuccess: false }).then((saved) => {
        if (saved) void activate();
      });
    } else {
      void activate();
    }
    return;
  }

  if (event.target.closest("[data-writing-download]")) {
    if (writingEditorLocked()) return;
    downloadWritingEditorMarkdown();
    return;
  }

  if (event.target.closest("[data-writing-apply]")) {
    void applyWritingEditor();
    return;
  }

  if (event.target.closest("[data-writing-ai-request]")) {
    void sendWritingEditRequestToAi();
    return;
  }

  const writingTone = event.target.closest("[data-writing-tone]");
  if (writingTone) {
    if (writingEditorLocked()) return;
    setWritingEditorTone(writingTone.dataset.writingTone);
    return;
  }

  const writingModeToggle = event.target.closest("[data-writing-mode-toggle]");
  if (writingModeToggle) {
    if (writingEditorLocked()) return;
    writingEditorCanvas()?.focus();
    return;
  }

  const writingSkill = event.target.closest("[data-writing-skill-id]");
  if (writingSkill) {
    applyWritingSkillPrompt(writingSkill, ensureWritingEditor());
    return;
  }

  const quickPrompt = event.target.closest("[data-writing-prompt]");
  if (quickPrompt) {
    if (writingEditorLocked()) return;
    const input = ensureWritingEditor().querySelector("[data-writing-request]");
    input.value = quickPrompt.dataset.writingPrompt;
    syncWritingEditorChatbox(input.closest("#writingEditorModal"));
    input.focus();
    return;
  }

  if (event.target.id === "writingEditorModal") {
    if (writingEditorLocked()) return;
    closeWritingEditor();
  }
});

document.addEventListener("keydown", (event) => {
  const modal = document.querySelector("#writingEditorModal");
  if (event.key === "Enter" && !event.shiftKey && event.target.closest?.("[data-writing-request]")) {
    if (!writingEditorLocked(modal)) {
      if (!event.target.value.trim()) return;
      event.preventDefault();
      void sendWritingEditRequestToAi();
    }
    return;
  }
  if (modal && !modal.hidden && event.key === "Tab") {
    const focusable = [...modal.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")];
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (event.key !== "Escape") return;
  if (state.mode === "v06" && state.v06.detailModal) {
    event.preventDefault();
    closeV06DetailModal();
    return;
  }
  if (!writingEditorLocked()) closeWritingEditor();
});


async function bootstrapApp() {
  updateSaveStatusTimestamp();
  const sessionId = new URLSearchParams(window.location.search).get("session");
  if (sessionId) {
    await loadWorkflowSession(sessionId, { updateUrl: false });
    return;
  }

  state.mode = "brunch-chat";
  let saved = null;
  try {
    saved = readBrunchChatStorage();
    brunchChatStorageRestoreError = null;
  } catch (error) {
    if (!(error instanceof BrunchChatStorageError)) throw error;
    brunchChatStorageRestoreError = error;
  }
  state.brunchChat = createBrunchChatState(saved);
  if (brunchChatStorageRestoreError) {
    state.brunchChat.error = copyCatalog.brunchChat.storageRestoreError;
  } else {
    persistCurrentBrunchChat();
  }
  brunchChatScrollMode = "initial";
  brunchChatHistoryScrollMode = "initial";
  renderApp();
  void loadBrunchChatCapabilities();
  void loadBrunchWritingSkills();
}

bootstrapApp();
  drawers.bind();
  bindPanelResizer(nodes);
  providerStatus.bind();

  nodes.workflowToggle?.addEventListener("click", toggleWorkflowRail);
  document.querySelector("#openV06Debug")?.addEventListener("click", () => {
    if (state.v06.operator?.debug_url) window.location.href = state.v06.operator.debug_url;
  });
  document.addEventListener("click", closeWorkflowRailOnOutsideClick);
  document.addEventListener("keydown", closeWorkflowRailOnEscape);
}

boot().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${escapeHtml(error.message)}</pre>`;
});
