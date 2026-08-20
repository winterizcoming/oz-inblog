import { workflowSteps } from "./state.js";
import { escapeHtml, markdownBlock, renderActions, renderCenterOptions, renderCurrentStep } from "./renderers.js";
import { buildSourceSelectionProjection } from "./source-selection-projection.js";
import { createSourceSelectionViewController } from "./source-selection-view.js";
import {
  brunchChatWelcome,
  BRUNCH_CHAT_DEFAULT_MODEL,
  BRUNCH_CHAT_DEFAULT_MODEL_PRESET,
  getBrunchChatChatboxState,
  getBrunchChatInputVariant,
  getBrunchChatExplicitQuestion,
  getBrunchChatQuestion,
  isCuratedBrunchChatProfile
} from "./brunch-chat-state.js";
import { copyCatalog } from "../copy-catalog.js";

function renderValue(value) {
  if (Array.isArray(value)) return value.map((item) => renderValue(item)).join(", ");
  if (value && typeof value === "object") {
    return value.title ?? value.label ?? value.id ?? JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "완료" : "대기";
  return value ?? "";
}

function summaryText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "완료" : "대기";
  return value ?? "";
}

function stateRows(state = {}) {
  const rows = [
    ["대상 채널", state.target_channel],
    ["목적", state.purpose],
    ["트랙", state.track],
    ["선택 각도", state.selected_angle_id],
    ["목차", state.proposed_outline_id],
    ["초안", state.draft_id],
    ["패키지", state.package_id],
    ["소스 검토", state.source_reviewed],
    ["목적 확정", state.purpose_confirmed]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  if (rows.length === 0) {
    return `<li><span>진행 상태</span><b title="대기">대기</b></li>`;
  }

  return rows
    .map(([label, value]) => {
      const text = summaryText(value);
      return `<li>
        <span>${escapeHtml(label)}</span>
        <b class="summary-value" title="${escapeHtml(text)}">${escapeHtml(text)}</b>
      </li>`;
    })
    .join("");
}


function factCheckItems(viewModel) {
  const packageChecks = viewModel.ui.package?.fact_check_items ?? viewModel.ui.package?.checklist;
  const values = viewModel.stateSummary.fact_check_items ?? viewModel.ui.checklist ?? packageChecks ?? [];
  return Array.isArray(values) ? values : [];
}

function factLabel(item) {
  if (typeof item === "string") return item;
  return item.label ?? item.title ?? item.note ?? item.description ?? item.id ?? JSON.stringify(item);
}

function factSeverity(item) {
  if (item && typeof item === "object" && item.severity === "warning") return "warning";
  return "info";
}

function factReferenceUrl(item, viewModel) {
  const metadata = item && typeof item === "object" ? item.metadata ?? {} : {};
  const explicitUrl = metadata.url ?? metadata.source_url ?? metadata.reference_url;
  const references = [
    ...(Array.isArray(viewModel.stateSummary?.references) ? viewModel.stateSummary.references : []),
    ...(Array.isArray(viewModel.ui.references) ? viewModel.ui.references : []),
    ...(Array.isArray(viewModel.ui.package?.references) ? viewModel.ui.package.references : [])
  ];
  const byId = metadata.reference_id
    ? references.find((reference) => reference.id === metadata.reference_id)?.url ?? ""
    : "";
  const label = factLabel(item).toLowerCase();
  const domain = label.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i)?.[1];
  const byDomain = domain
    ? references.find((reference) => {
        try {
          return new URL(reference.url).hostname.toLowerCase().includes(domain);
        } catch {
          return false;
        }
      })?.url
    : "";
  const candidate = explicitUrl || byId || byDomain;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function factMarkup(item, viewModel) {
  const label = factLabel(item);
  const url = factReferenceUrl(item, viewModel);
  const content = url
    ? `<a class="fact-source-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : escapeHtml(label);
  return `<div>
    <span class="${url ? "source" : factSeverity(item) === "warning" ? "warning" : "info"}">${url ? "Sources" : "Check"}</span>
    <strong>${content}</strong>
  </div>`;
}

function renderLeft(context, viewModel) {
  const facts = factCheckItems(viewModel);
  const factRows =
    facts.length > 0
      ? facts
          .map((item) => {
            const warning = factSeverity(item) === "warning";
            const url = factReferenceUrl(item, viewModel);
            return `<li>
      <div><i class="${warning ? "warn-icon" : "check-icon"}"></i><p>${escapeHtml(factLabel(item))}</p></div>
      <span class="${url ? "source-tag" : warning ? "orange-tag" : "green-tag"}">${url ? "Sources" : "Check"}</span>
    </li>`;
          })
          .join("")
      : `<li><div><i class="check-icon"></i><p>검증 필요 항목 없음</p></div><span class="green-tag">Text</span></li>`;

  const timeline = context.getTimeline();
  const availableSteps = new Set(timeline.responses.map((response) => response.step));
  const selectedStep = timeline.selectedResponse?.step ?? viewModel.step;
  const progressStep = timeline.responses.at(-1)?.step ?? viewModel.step;
  const workflowCompleted = context.getWorkflowCompleted?.() ?? false;
  context.nodes.left.innerHTML = `<div class="rail-section">
    <div class="rail-head"><p class="eyebrow">워크플로우 진행 상황</p><span class="rail-nav"><button class="rail-nav-button" type="button" data-nav="previous" aria-label="이전 단계" ${timeline.canGoPrevious ? "" : "disabled"}>‹</button><button class="rail-nav-button" type="button" data-nav="next" aria-label="다음 단계" ${timeline.canGoNext ? "" : "disabled"}>›</button></span></div>
    <div class="step-list">${workflowSteps
      .map(([id, label], index) => {
        const hasResponse = availableSteps.has(id);
        const status = workflowRailStepState({ id, hasResponse, progressStep, workflowCompleted, stateSummary: viewModel.stateSummary });
        const selected = id === selectedStep;
        const clickable = hasResponse || status === "progress";
        return `<button class="step-row ${status} ${selected ? "selected" : ""}" type="button" data-step-id="${escapeHtml(id)}" data-step-index="${index}" ${clickable ? "" : "disabled"}>
        <span>${status === "done" ? "✓" : index + 1}</span><p>${escapeHtml(label)}</p><small>${status === "progress" ? "진행 중" : status === "done" ? "완료" : "대기"}</small>
      </button>`;
      })
      .join("")}</div>
  </div>
  <div class="state-card">
    <p class="eyebrow">상태 요약</p>
    <ul>${stateRows(viewModel.stateSummary)}</ul>
    <button class="detail-button" type="button">자세히 보기</button>
  </div>
  <div class="fact-card">
    <p class="eyebrow">검토 필요 (Fact-check)</p>
    <ul class="mini-checks">${factRows}</ul>
  </div>
  <button class="debug-button" id="openDebug" type="button"><span class="icon-code"></span>Debug JSON 보기<span class="debug-chevron">›</span></button>`;
  context.nodes.left.querySelector("#openDebug").addEventListener("click", context.onOpenDebug);
  context.nodes.left.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", context.onNavigate);
  });
  context.nodes.left.querySelectorAll("[data-step-id]").forEach((button) => {
    button.addEventListener("click", context.onNavigateStep);
  });
}

export function workflowRailStepState({ id, hasResponse, progressStep, workflowCompleted, stateSummary = {} }) {
  const trackSelected = id === "track_selection" && (
    ["brunch", "official_inblog"].includes(String(stateSummary.target_track ?? stateSummary.track ?? ""))
    || ["brunch", "inblog"].includes(String(stateSummary.target_channel ?? ""))
  );
  if (workflowCompleted || id === progressStep) return workflowCompleted ? "done" : "progress";
  return hasResponse || trackSelected ? "done" : "pending";
}

export function sourceSelectionSummaryCount({ selection = {}, renderedIds = [], renderedSelectedIds = [] }) {
  void renderedIds;
  void renderedSelectedIds;
  return buildSourceSelectionProjection(selection).counts.effective;
}

function formatElapsed(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${minutes}m ${rest}s`;
}

function renderPendingTurn(context) {
  const pendingTurn = context.getPendingTurn?.();
  if (!pendingTurn) return "";
  const elapsed = formatElapsed(context.getGeneratingElapsedSeconds?.() ?? 0);
  return `<div class="pending-turn">
    <div class="assistant-pending" aria-live="polite">
      <p class="pending-elapsed" data-pending-elapsed>${escapeHtml(elapsed)} 동안 작업 중입니다</p>
      <p class="thinking-shimmer">생각 중</p>
    </div>
  </div>`;
}

function renderAssistantConversationTurn(turn) {
  const message = turn.message || "";
  const title = turn.title || turn.step || "응답";
  const stepLabel = turn.step || "assistant";
  const turnKey = turn.turnKey || `assistant-step-${turn.step || "unknown"}`;
  const revealPending = Boolean(turn.revealPending);
  return `<article class="message plain topic-message conversation-turn conversation-assistant-turn${revealPending ? " assistant-reveal-pending" : ""}" data-turn-key="${escapeHtml(turnKey)}" data-step-id="${escapeHtml(turn.step || "")}">
    <p class="${revealPending ? "assistant-reveal-hidden" : ""}">${escapeHtml(message).replaceAll("\n", "<br />")}</p>
    <div class="topic-chip${revealPending ? " assistant-reveal-hidden" : ""}"><span>${escapeHtml(stepLabel)}</span>${escapeHtml(title)}</div>
  </article>
  ${
    turn.recommendationReason
      ? `<article class="message plain conversation-reason${revealPending ? " assistant-reveal-hidden" : ""}" data-parent-turn-key="${escapeHtml(turnKey)}"><p>${escapeHtml(turn.recommendationReason)}</p></article>`
      : ""
  }`;
}

function renderUserConversationTurn(turn) {
  const turnKey = turn.turnKey || `user-${turn.turnId || turn.targetStep || "unknown"}`;
  return `<article class="message user-turn conversation-turn" data-turn-key="${escapeHtml(turnKey)}" data-step-id="${escapeHtml(turn.targetStep || turn.currentStep || "")}">
    <p>${escapeHtml(turn.message ?? "").replaceAll("\n", "<br />")}</p>
  </article>`;
}

function renderConversationTurn(turn) {
  return turn.role === "user" ? renderUserConversationTurn(turn) : renderAssistantConversationTurn(turn);
}

function renderFallbackConversation(viewModel) {
  return `<article class="message plain topic-message">
      <p>${escapeHtml(viewModel.conversationMessage).replaceAll("\n", "<br />")}</p>
      <div class="topic-chip"><span>${escapeHtml(viewModel.stepLabel)}</span>${escapeHtml(viewModel.ui.title ?? viewModel.stepLabel)}</div>
    </article>
    ${viewModel.recommendationReason ? `<article class="message plain"><p>${escapeHtml(viewModel.recommendationReason)}</p></article>` : ""}`;
}

function renderConversationMessages(context, viewModel) {
  const turns = context.getConversationTurns?.() ?? [];
  const history = turns.length > 0 ? turns.map(renderConversationTurn).join("") : renderFallbackConversation(viewModel);
  const pending = context.getIsGenerating?.() ? renderPendingTurn(context) : "";
  return `${history}${pending}`;
}

function brunchModelName(model = "") {
  const match = String(model).match(/gpt-5\.6-(luna|terra|sol)/iu);
  return match ? `GPT 5.6 ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` : String(model || "Codex");
}

function brunchEffortName(effort = "medium") {
  const names = { low: "Low", medium: "Mid", high: "High", xhigh: "xHigh", max: "Max" };
  return names[String(effort).toLowerCase()] ?? String(effort || "Mid");
}

function readinessLabel(readiness) {
  const copy = copyCatalog.brunchChat.readiness;
  if (readiness?.status === "evaluating") return copy.evaluating;
  if (readiness?.status === "failed") return copy.failed;
  if (readiness?.status === "stale") return copy.stale;
  if (readiness?.band === "needs_work") return copy.needsWork;
  if (readiness?.band === "almost_ready") return copy.almostReady;
  if (readiness?.band === "ready") return copy.ready;
  return copy.pending;
}

export function renderBrunchReadinessSummary(readiness, messageIndex = "") {
  if (!readiness) return "";
  const copy = copyCatalog.brunchChat.readiness;
  const summary = typeof readiness.summary === "string" && readiness.summary.trim() ? readiness.summary : copy.summaryFallback;
  const blocker = Array.isArray(readiness.blockers) && readiness.blockers[0]
    ? `<p class="brunch-writing-readiness-blocker"><span>${escapeHtml(copy.blocker)}</span>: ${escapeHtml(readiness.blockers[0].message ?? "")}</p>`
    : "";
  const state = readiness.status ?? readiness.band ?? "pending";
  const retry = ["failed", "stale"].includes(state)
    ? `<button type="button" class="brunch-writing-readiness-retry" data-readiness-retry="${escapeHtml(String(messageIndex))}">${escapeHtml(copy.retry)}</button>`
    : "";
  return `<div class="brunch-writing-readiness brunch-writing-readiness-${escapeHtml(state)}" data-readiness-state="${escapeHtml(state)}">
    <div class="brunch-writing-readiness-head"><span>${escapeHtml(readinessLabel(readiness))}</span>${readiness.status === "evaluating" ? '<span class="brunch-writing-readiness-spinner" aria-hidden="true"></span>' : retry}</div>
    <p>${escapeHtml(summary)}</p>
    ${blocker}
  </div>`;
}

function renderBrunchChatModelSelector(chat) {
  const capabilities = Array.isArray(chat.modelCapabilities) ? chat.modelCapabilities : [];
  const visibleEfforts = new Set(["medium", "high", "xhigh", "max"]);
  const fallback = [BRUNCH_CHAT_DEFAULT_MODEL];
  const options = (capabilities.length ? capabilities : fallback).filter((option) => {
    const model = String(option.model ?? "").toLowerCase();
    return /^gpt-5\.6-(luna|terra|sol)$/u.test(model) && visibleEfforts.has(String(option.reasoningEffort).toLowerCase());
  });
  const current = options.find((option) => option.preset === chat.modelPreset)
    ?? options.find((option) => option.preset === BRUNCH_CHAT_DEFAULT_MODEL_PRESET)
    ?? options[0];
  const families = ["luna", "terra", "sol"];
  const familyMarkup = families.map((family) => {
    const familyOptions = options.filter((option) => String(option.model).toLowerCase().endsWith(`-${family}`));
    if (familyOptions.length === 0) return "";
    const selectedFamily = current && String(current.model).toLowerCase().endsWith(`-${family}`);
    const familyLabel = brunchModelName(familyOptions[0].model);
    const effortMarkup = familyOptions.map((option) => {
      const selected = option.preset === current?.preset;
      return `<button type="button" class="brunch-chat-effort-option${selected ? " is-selected" : ""}" role="menuitem" aria-current="${selected ? "true" : "false"}" data-brunch-model-preset="${escapeHtml(option.preset)}">
        <span>${escapeHtml(brunchEffortName(option.reasoningEffort))}</span>
      </button>`;
    }).join("");
    return `<div class="brunch-chat-model-family" data-brunch-model-family="${family}">
      <button type="button" class="brunch-chat-model-family-button${selectedFamily ? " is-selected" : ""}" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-brunch-model-family-toggle="${family}">
        <span>${escapeHtml(familyLabel)}</span><span aria-hidden="true">›</span>
      </button>
      <div class="brunch-chat-effort-menu" data-brunch-effort-menu="${family}" role="menu" aria-label="${escapeHtml(familyLabel)}" aria-hidden="true">${effortMarkup}</div>
    </div>`;
  }).join("");
  const modelUnavailable = capabilities.length === 0;
  return `<div class="brunch-chat-model-selector">
    <button type="button" class="model-pill brunch-chat-model-toggle" data-brunch-model-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(copyCatalog.brunchChat.modelSelect)}" ${chat.isLoading || modelUnavailable ? "disabled" : ""}>${escapeHtml(brunchModelName(current?.model))}<span class="brunch-chat-model-effort">${escapeHtml(brunchEffortName(current?.reasoningEffort))}</span></button>
    <div class="brunch-chat-model-menu" data-brunch-model-menu role="menu" aria-label="${escapeHtml(copyCatalog.brunchChat.modelSelect)}" hidden>${familyMarkup}</div>
  </div>`;
}

function renderBrunchChatVersionActions(index, messageMeta, hasPreview) {
  const canManageVersion = Boolean(messageMeta.turnId && messageMeta.versionId);
  if (!canManageVersion) {
    return `<div class="message-actions chat-message-actions brunch-chat-action-row">
      <button type="button" class="message-action-button" data-copy-chat-turn="${index}" aria-label="${escapeHtml(hasPreview ? copyCatalog.brunchChat.copyPreview : copyCatalog.brunchChat.copyResponse)}" title="${escapeHtml(hasPreview ? copyCatalog.brunchChat.copyPreview : copyCatalog.brunchChat.copyResponse)}"><img src="/assets/Copy.svg" width="16" height="16" alt="" /></button>
    </div>`;
  }
  const summaries = Array.isArray(messageMeta.versionSummaries) ? messageMeta.versionSummaries : [];
  const curated = isCuratedBrunchChatProfile(messageMeta.runtimeProfile);
  const currentVersionId = messageMeta.versionId ?? "";
  const actionDisabled = messageMeta.actionDisabled ? " disabled" : "";
  const versionItems = summaries.length
    ? summaries.map((version, versionIndex) => {
      const selected = version.versionId === currentVersionId || (version.active && !currentVersionId);
      const label = `v${Number.isInteger(version.index) ? version.index + 1 : versionIndex + 1}`;
      const details = [brunchModelName(version.model), brunchEffortName(version.reasoningEffort)].filter(Boolean).join(" · ");
      const restoreUnavailable = curated && version.restoreAvailable !== true;
      const actionAttribute = curated ? `data-restore-chat-version="${escapeHtml(version.versionId)}"` : `data-activate-chat-version="${escapeHtml(version.versionId)}"`;
      return `<button type="button" class="brunch-chat-version-option${selected ? " is-selected" : ""}" role="option" aria-selected="${String(selected)}" ${actionAttribute} data-chat-turn-index="${index}"${restoreUnavailable ? " disabled" : ""}><span>${escapeHtml(label)}</span><small>${escapeHtml(details)}</small></button>`;
    }).join("")
    : `<button type="button" class="brunch-chat-version-option is-selected" role="option" aria-selected="true" disabled><span>v1</span><small>${escapeHtml(copyCatalog.brunchChat.currentVersion)}</small></button>`;
  const legacyActions = `<button type="button" class="message-action-button" data-regenerate-chat-turn="${index}" aria-label="${escapeHtml(copyCatalog.brunchChat.regenerate)}" title="${escapeHtml(copyCatalog.brunchChat.regenerate)}"${actionDisabled}><img src="/assets/ArrowCounterClockwise.svg" width="16" height="16" alt="" /></button>
    <button type="button" class="message-action-button" data-branch-chat-turn="${index}" aria-label="${escapeHtml(copyCatalog.brunchChat.branch)}" title="${escapeHtml(copyCatalog.brunchChat.branch)}"${actionDisabled}><img src="/assets/FlowArrow.svg" width="16" height="16" alt="" /></button>`;
  return `<div class="message-actions chat-message-actions brunch-chat-action-row">
    <button type="button" class="message-action-button" data-copy-chat-turn="${index}" aria-label="${escapeHtml(hasPreview ? copyCatalog.brunchChat.copyPreview : copyCatalog.brunchChat.copyResponse)}" title="${escapeHtml(hasPreview ? copyCatalog.brunchChat.copyPreview : copyCatalog.brunchChat.copyResponse)}"><img src="/assets/Copy.svg" width="16" height="16" alt="" /></button>
    ${curated ? "" : legacyActions}
    <span class="brunch-chat-action-menu-wrap">
      <button type="button" class="message-action-button" data-version-menu-toggle="${index}" aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(copyCatalog.brunchChat.versionHistory)}" title="${escapeHtml(copyCatalog.brunchChat.versionHistory)}"${actionDisabled}><img src="/assets/ClockCounterClockwise.svg" width="16" height="16" alt="" /></button>
      <div class="brunch-chat-version-menu" data-version-menu="${index}" role="listbox" aria-label="${escapeHtml(copyCatalog.brunchChat.versionHistory)}" hidden>${versionItems}</div>
    </span>
  </div>`;
}

function renderBrunchChatAssistantTurn(turn, index, messageMeta = {}) {
  const content = turn.content ?? {};
  const turnKey = `chat-assistant-${index}`;
  const preview = content.writing_preview;
  const previewMarkdown = preview && typeof preview.markdown === "string"
    ? preview.markdown.replace(/^\s*#{1,6}\s+([^\n]+)\s*(?:\n|$)/u, (heading, text) => text.trim() === String(preview.title ?? "").trim() ? "" : heading)
    : "";
  const previewMarkup = preview && typeof preview === "object"
    ? `<section class="editable-writing-section brunch-writing-preview"
        data-writing-section-id="brunch-writing-preview"
        data-writing-source-step="brunch-chat"
        data-writing-chat-index="${index}"
        data-writing-turn-id="${escapeHtml(messageMeta.turnId ?? "")}"
        data-writing-version-id="${escapeHtml(messageMeta.versionId ?? "")}"
        data-writing-title="${escapeHtml(preview.title)}"
        data-writing-content="${escapeHtml(preview.markdown)}">
        <div class="writing-card-head">
          <span>${escapeHtml(copyCatalog.brunchChat.writingPreview)}</span>
          <div><button type="button" data-writing-open>${escapeHtml(copyCatalog.writing.edit)}</button></div>
        </div>
        <h2 class="brunch-writing-preview-title">${escapeHtml(preview.title)}</h2>
        ${preview.subtitle && preview.subtitle !== copyCatalog.brunchChat.writingPreview ? `<p class="brunch-writing-preview-subtitle">${escapeHtml(preview.subtitle)}</p>` : ""}
        ${markdownBlock(previewMarkdown)}
        ${renderBrunchReadinessSummary(messageMeta.readiness ?? { status: "pending" }, index)}
      </section>`
    : "";
  return `<article class="message plain topic-message conversation-turn conversation-assistant-turn brunch-chat-assistant-turn" data-turn-key="${escapeHtml(turnKey)}">
    ${markdownBlock(content.markdown ?? "")}
    ${previewMarkup}
    ${renderBrunchChatVersionActions(index, messageMeta, Boolean(preview))}
  </article>`;
}

function renderBrunchChatUserTurn(turn, index) {
  return `<article class="message user-turn conversation-turn brunch-chat-user-turn" data-turn-key="chat-user-${index}">
    <p>${escapeHtml(turn.content ?? "").replaceAll("\n", "<br />")}</p>
  </article>`;
}

function renderBrunchChatMessages(chat) {
  const messages = chat.messages?.length ? chat.messages : [{ role: "assistant", content: brunchChatWelcome() }];
  return messages.map((turn, index) => turn.role === "user"
    ? renderBrunchChatUserTurn(turn, index)
    : renderBrunchChatAssistantTurn(turn, index, { ...(chat.messageMeta?.[String(index)] ?? {}), runtimeProfile: chat.runtimeProfile, actionDisabled: chat.isLoading })).join("");
}

function renderBrunchChatPending(context) {
  const elapsed = formatElapsed(context.getGeneratingElapsedSeconds?.() ?? 0);
  const activityKey = context.getBrunchChatActivity?.() ?? "request_received";
  const activity = copyCatalog.brunchChat.generationActivity?.[activityKey] ?? copyCatalog.brunchChat.loading;
  return `<div class="pending-turn brunch-chat-pending">
    <div class="assistant-pending" aria-live="polite">
      <p class="pending-elapsed" data-pending-elapsed>${escapeHtml(elapsed)} 동안 작업 중입니다</p>
      <p class="thinking-shimmer" data-pending-activity>${escapeHtml(activity)}</p>
    </div>
  </div>`;
}

function renderBrunchChatChoices(chat, choices) {
  return choices.map((choice, index) => {
    const selected = index === chat.selectedChoiceIndex;
    const description = typeof choice.description === "string" ? choice.description.trim() : "";
    return `<button class="center-option brunch-chat-choice${selected ? " selected" : ""}" type="button" role="radio" aria-checked="${String(selected)}" tabindex="${selected ? "0" : "-1"}" data-chat-choice-index="${index}">
      <b>${index + 1}</b>
      <span class="brunch-chat-choice-copy"><strong>${escapeHtml(choice.label)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>
    </button>`;
  }).join("");
}

function renderBrunchChatStepInput(chat) {
  const typing = getBrunchChatChatboxState(chat) === "typing";
  return `<label class="free-revise brunch-chat-step-input ${typing ? "is-typing" : "is-resting"}">
      <span class="free-revise-icon" aria-hidden="true"><img src="/assets/PencilSimple.svg" width="14" height="14" alt="" /></span>
      <textarea rows="1" aria-label="${escapeHtml(copyCatalog.brunchChat.stepInputPlaceholder)}" placeholder="${escapeHtml(copyCatalog.brunchChat.stepInputPlaceholder)}">${escapeHtml(chat.draft ?? "")}</textarea>
    </label>`;
}

function renderBrunchChatChatbox(chat) {
  const chatboxState = getBrunchChatChatboxState(chat);
  const isLoading = chatboxState === "thinking";
  const hasDraft = Boolean(String(chat.draft ?? "").trim());
  const button = chatboxState === "abort"
    ? `<button class="brunch-chatbox-submit brunch-chatbox-submit-abort stop-generation-button" type="button" aria-label="${escapeHtml(copyCatalog.brunchChat.stop)}"><span aria-hidden="true"></span></button>`
    : chatboxState === "thinking"
      ? `<button class="brunch-chatbox-submit brunch-chatbox-submit-thinking" type="button" disabled aria-label="${escapeHtml(copyCatalog.brunchChat.thinking)}"><img src="/assets/ChatThinking.svg" width="18" height="18" alt="" /></button>`
      : `<button class="brunch-chatbox-submit ${hasDraft ? "is-active" : "is-disabled"}" type="button" ${hasDraft ? "" : "disabled"} aria-label="${escapeHtml(copyCatalog.brunchChat.continue)}"><img src="/assets/${hasDraft ? "ChatArrowActive.svg" : "ChatArrowDisabled.svg"}" width="18" height="18" alt="" /></button>`;
  return `<div class="brunch-chat-chatbox brunch-chat-chatbox-${chatboxState}" data-chatbox-state="${chatboxState}">
    <label class="brunch-chatbox-field">
      <span class="sr-only">${escapeHtml(copyCatalog.brunchChat.chatboxPlaceholder)}</span>
      <textarea rows="1" aria-label="${escapeHtml(copyCatalog.brunchChat.chatboxPlaceholder)}" placeholder="${escapeHtml(copyCatalog.brunchChat.chatboxPlaceholder)}" ${isLoading ? "disabled" : ""}>${escapeHtml(chat.draft ?? "")}</textarea>
    </label>
    ${button}
  </div>`;
}

export function syncBrunchChatDraftUi(chat, roots = [], { composing = false } = {}) {
  const draft = String(chat?.draft ?? "");
  const hasDraft = Boolean(draft.trim());
  const chatboxState = getBrunchChatChatboxState(chat);
  roots.filter(Boolean).forEach((root) => {
    const textarea = root.querySelector(".brunch-chat-composer textarea, .brunch-chat-chatbox textarea");
    const activeElement = textarea?.ownerDocument?.activeElement;
    if (textarea && textarea !== activeElement && !composing && textarea.value !== draft) textarea.value = draft;
    root.querySelectorAll("[data-chat-choice-index]").forEach((item) => {
      item.classList.remove("selected");
      item.setAttribute("aria-checked", "false");
      item.setAttribute("tabindex", "-1");
    });
    const stepInput = root.querySelector(".brunch-chat-step-input");
    if (stepInput) {
      stepInput.classList.toggle("is-typing", hasDraft);
      stepInput.classList.toggle("is-resting", !hasDraft);
    }
    const chatbox = root.querySelector(".brunch-chat-chatbox");
    if (!chatbox) return;
    chatbox.classList.remove("brunch-chat-chatbox-resting", "brunch-chat-chatbox-typing", "brunch-chat-chatbox-abort", "brunch-chat-chatbox-thinking");
    chatbox.classList.add(`brunch-chat-chatbox-${chatboxState}`);
    chatbox.dataset.chatboxState = chatboxState;
    syncBrunchChatTextareaHeight(chatbox.querySelector("textarea"));
    const submit = chatbox.querySelector(".brunch-chatbox-submit:not(.stop-generation-button)");
    if (!submit || chat?.isLoading) return;
    submit.disabled = !hasDraft;
    submit.classList.toggle("is-active", hasDraft);
    submit.classList.toggle("is-disabled", !hasDraft);
    const icon = submit.querySelector("img");
    if (icon) icon.src = `/assets/${hasDraft ? "ChatArrowActive.svg" : "ChatArrowDisabled.svg"}`;
  });
}

function renderBrunchChatResponseHistory(chat) {
  const messages = chat.messages ?? [];
  return messages.map((turn, index) => {
    if (turn.role !== "user") return "";
    const precedingAssistant = messages[index - 1]?.role === "assistant" ? messages[index - 1] : null;
    const question = precedingAssistant?.content
      ? getBrunchChatQuestion(precedingAssistant.content)
      : index === messages.findIndex((message) => message.role === "user")
        ? brunchChatWelcome().question
        : getBrunchChatQuestion(null);
    return `<div class="brunch-chat-history-item">
    <p class="brunch-chat-history-question">${escapeHtml(question)}</p>
    <p class="brunch-chat-history-answer">→ ${escapeHtml(turn.content ?? "")}</p>
  </div>`;
  }).join("");
}

function buildBrunchChatUserInputMarkup(chat) {
  const latestAssistant = [...(chat.messages ?? [])].reverse().find((turn) => turn.role === "assistant");
  const choices = latestAssistant?.content?.choices ?? (chat.messages?.length ? [] : brunchChatWelcome().choices);
  const explicitQuestion = getBrunchChatExplicitQuestion(latestAssistant?.content);
  const isWelcome = !latestAssistant && !(chat.messages?.length);
  const question = explicitQuestion || (choices.length ? (isWelcome ? brunchChatWelcome().question : getBrunchChatQuestion(latestAssistant?.content)) : "");
  const displayQuestion = chat.isLoading ? "" : question;
  const notice = chat.error ? { type: "error", message: chat.error } : null;
  const inputVariant = getBrunchChatInputVariant(chat);
  const bodyMarkup = inputVariant === "steps"
    ? `<div class="center-selection brunch-chat-selection brunch-chat-steps" data-user-input-variant="steps">
        ${displayQuestion ? `<p class="choice-title">${escapeHtml(displayQuestion)}</p>` : ""}
        <div class="center-option-scroll-shell">
          <div class="center-option-scroll" role="radiogroup" aria-label="${escapeHtml(displayQuestion)}">${renderBrunchChatChoices(chat, choices)}</div>
          <div class="center-scrollbar" aria-hidden="true"><span></span></div>
        </div>
        ${notice ? `<p class="workflow-notice error" role="alert">${escapeHtml(notice.message)}</p>` : ""}
        <div class="composer brunch-chat-composer brunch-chat-step-composer">
          ${renderBrunchChatStepInput(chat)}
          <button class="continue-button" type="button">${escapeHtml(copyCatalog.brunchChat.continue)}</button>
        </div>
      </div>`
    : `<div class="brunch-chat-default-input" data-user-input-variant="default">
        ${displayQuestion ? `<p class="choice-title brunch-chat-question">${escapeHtml(displayQuestion)}</p>` : ""}
        ${renderBrunchChatChatbox(chat)}
        ${notice ? `<p class="workflow-notice error" role="alert">${escapeHtml(notice.message)}</p>` : ""}
      </div>`;
  return { bodyMarkup, historyMarkup: renderBrunchChatResponseHistory(chat), question, choices };
}

export { buildBrunchChatUserInputMarkup, renderBrunchChatMessages, renderBrunchChatResponseHistory };

function syncBrunchChatTextareaHeight(textarea) {
  if (!textarea) return;
  const styles = globalThis.getComputedStyle?.(textarea);
  const lineHeight = Number.parseFloat(styles?.lineHeight ?? "") || 22;
  const paddingTop = Number.parseFloat(styles?.paddingTop ?? "") || 0;
  const paddingBottom = Number.parseFloat(styles?.paddingBottom ?? "") || 0;
  const minHeight = lineHeight + paddingTop + paddingBottom;
  const maxHeight = lineHeight * 4 + paddingTop + paddingBottom;
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight || minHeight;
  const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

function bindBrunchChatUserInput(context, chat, inputRoot) {
  if (!inputRoot) return;
  const choiceButtons = () => [...inputRoot.querySelectorAll("[data-chat-choice-index]")];
  const selectChoice = (selectedIndex, { focus = false } = {}) => {
    const buttons = choiceButtons();
    if (!buttons.length) return;
    const nextIndex = Math.max(0, Math.min(buttons.length - 1, selectedIndex));
    buttons.forEach((item, itemIndex) => {
      const selected = itemIndex === nextIndex;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-checked", String(selected));
      item.setAttribute("tabindex", selected ? "0" : "-1");
    });
    context.onChatChoice?.(nextIndex);
    if (focus) buttons[nextIndex]?.focus();
  };
  choiceButtons().forEach((button) => {
    button.addEventListener("click", () => {
      selectChoice(Number(button.dataset.chatChoiceIndex));
    });
    button.addEventListener("keydown", (event) => {
      if (chat.isLoading) return;
      const buttons = choiceButtons();
      const currentIndex = Number(button.dataset.chatChoiceIndex);
      let nextIndex = currentIndex;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % buttons.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = buttons.length - 1;
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectChoice(currentIndex, { focus: true });
        return;
      } else return;
      event.preventDefault();
      selectChoice(nextIndex, { focus: true });
    });
    button.addEventListener("dblclick", () => {
      if (chat.isLoading || !button.classList.contains("selected")) return;
      context.onChatContinue?.();
    });
  });

  const textarea = inputRoot.querySelector(".brunch-chat-composer textarea, .brunch-chat-chatbox textarea");
  const freeReviseTextarea = inputRoot.querySelector(".brunch-chat-step-input textarea");
  syncBrunchChatTextareaHeight(freeReviseTextarea);
  syncBrunchChatTextareaHeight(inputRoot.querySelector(".brunch-chat-chatbox textarea"));
  let compositionActive = false;
  let compositionEndFrame = 0;
  textarea?.addEventListener("compositionstart", () => {
    compositionActive = true;
    if (compositionEndFrame) {
      cancelAnimationFrame(compositionEndFrame);
      compositionEndFrame = 0;
    }
  });
  textarea?.addEventListener("compositionend", () => {
    compositionActive = false;
    compositionEndFrame = requestAnimationFrame(() => {
      compositionEndFrame = 0;
      if (textarea?.isConnected) {
        syncBrunchChatTextareaHeight(freeReviseTextarea);
        syncBrunchChatTextareaHeight(inputRoot.querySelector(".brunch-chat-chatbox textarea"));
        context.onChatDraft?.(textarea.value, { composing: false });
      }
    });
  });
  textarea?.addEventListener("input", (event) => {
    choiceButtons().forEach((item) => {
      item.classList.remove("selected");
      item.setAttribute("aria-checked", "false");
      item.setAttribute("tabindex", "-1");
    });
    const composing = compositionActive || event.isComposing;
    syncBrunchChatTextareaHeight(freeReviseTextarea);
    syncBrunchChatTextareaHeight(inputRoot.querySelector(".brunch-chat-chatbox textarea"));
    context.onChatDraft?.(event.target.value, { composing });
    if (!composing && compositionEndFrame) {
      cancelAnimationFrame(compositionEndFrame);
      compositionEndFrame = 0;
    }
  });
  textarea?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.shiftKey) return;
    event.preventDefault();
    context.onChatContinue?.();
  });
  inputRoot.querySelector(".continue-button, .brunch-chatbox-submit:not(.stop-generation-button)")?.addEventListener("click", context.onChatContinue);
  inputRoot.querySelector(".stop-generation-button")?.addEventListener("click", context.onChatStop);
}

function renderBrunchChatUserInput(context, chat) {
  const { bodyMarkup, historyMarkup } = buildBrunchChatUserInputMarkup(chat);
  context.nodes.right.setAttribute("aria-label", copyCatalog.brunchChat.userResponse);
  context.nodes.right.innerHTML = `<div class="panel-title-row brunch-chat-input-header">
    <h1 id="brunch-chat-response-title">${escapeHtml(copyCatalog.brunchChat.userResponse)}</h1>
  </div>
  <div class="brunch-chat-response-history" role="region" aria-labelledby="brunch-chat-response-title">${historyMarkup}</div>
  <section class="brunch-chat-user-input" aria-labelledby="brunch-chat-user-input-title">
    <h2 id="brunch-chat-user-input-title" class="sr-only">${escapeHtml(copyCatalog.brunchChat.userInput)}</h2>
    ${bodyMarkup}
  </section>`;
  bindBrunchChatUserInput(context, chat, context.nodes.right);
}

function renderBrunchChatConversation(context, chat) {
  const { bodyMarkup } = buildBrunchChatUserInputMarkup(chat);
  context.nodes.center.innerHTML = `<div class="panel-title-row">
    <h1>Conversation</h1>
    ${renderBrunchChatModelSelector(chat)}
  </div>
  <div class="message-stack brunch-chat-message-stack">${renderBrunchChatMessages(chat)}${chat.isLoading ? renderBrunchChatPending(context) : ""}</div>
  <section class="brunch-chat-narrow-user-input" aria-labelledby="brunch-chat-narrow-user-input-title">
    <h2 id="brunch-chat-narrow-user-input-title" class="sr-only">${escapeHtml(copyCatalog.brunchChat.userInput)}</h2>
    ${bodyMarkup}
  </section>`;
  bindBrunchChatUserInput(context, chat, context.nodes.center.querySelector(".brunch-chat-narrow-user-input"));

  context.nodes.center.querySelectorAll("[data-copy-chat-turn]").forEach((button) => {
    button.addEventListener("click", () => context.onChatCopy?.(Number(button.dataset.copyChatTurn)));
  });
  context.nodes.center.querySelectorAll("[data-regenerate-chat-turn]").forEach((button) => {
    button.addEventListener("click", () => context.onChatRegenerate?.(Number(button.dataset.regenerateChatTurn)));
  });
  context.nodes.center.querySelectorAll("[data-branch-chat-turn]").forEach((button) => {
    button.addEventListener("click", () => context.onChatBranch?.(Number(button.dataset.branchChatTurn)));
  });
  const closeVersionMenus = (restoreFocus = false) => {
    const openToggle = context.nodes.center.querySelector("[data-version-menu-toggle][aria-expanded=\"true\"]");
    context.nodes.center.querySelectorAll("[data-version-menu]").forEach((item) => { item.hidden = true; });
    context.nodes.center.querySelectorAll("[data-version-menu-toggle]").forEach((item) => item.setAttribute("aria-expanded", "false"));
    if (restoreFocus) openToggle?.focus();
  };
  if (context.nodes.center.dataset.brunchVersionMenuDismissBound !== "true") {
    context.nodes.center.addEventListener("click", (event) => {
      if (!event.target.closest("[data-version-menu-toggle], [data-version-menu]")) closeVersionMenus();
    });
    context.nodes.center.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const openToggle = context.nodes.center.querySelector("[data-version-menu-toggle][aria-expanded=\"true\"]");
        if (!openToggle) return;
        event.preventDefault();
        closeVersionMenus(true);
        return;
      }
      const option = event.target.closest("[data-activate-chat-version], [data-restore-chat-version]");
      if (!option || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const options = [...option.closest("[data-version-menu]")?.querySelectorAll("[data-activate-chat-version], [data-restore-chat-version]") ?? []];
      const currentIndex = options.indexOf(option);
      if (currentIndex < 0 || options.length === 0) return;
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      event.preventDefault();
      options[nextIndex]?.focus();
    });
    context.nodes.center.dataset.brunchVersionMenuDismissBound = "true";
  }
  context.nodes.center.querySelectorAll("[data-version-menu-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const menu = context.nodes.center.querySelector(`[data-version-menu="${CSS.escape(button.dataset.versionMenuToggle)}"]`);
      if (!menu) return;
      const open = menu.hidden;
      closeVersionMenus();
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
  });
  context.nodes.center.querySelectorAll("[data-activate-chat-version]").forEach((button) => {
    button.addEventListener("click", () => context.onChatActivateVersion?.(Number(button.dataset.chatTurnIndex), button.dataset.activateChatVersion));
  });
  context.nodes.center.querySelectorAll("[data-restore-chat-version]").forEach((button) => {
    button.addEventListener("click", () => context.onChatRestoreVersion?.(Number(button.dataset.chatTurnIndex), button.dataset.restoreChatVersion));
  });
  const modelToggle = context.nodes.center.querySelector("[data-brunch-model-toggle]");
  const modelMenu = context.nodes.center.querySelector("[data-brunch-model-menu]");
  const familyToggles = [...(modelMenu?.querySelectorAll("[data-brunch-model-family-toggle]") ?? [])];
  const effortMenus = [...(modelMenu?.querySelectorAll("[data-brunch-effort-menu]") ?? [])];
  const closeModelMenu = (restoreFocus = false) => {
    if (!modelMenu) return;
    modelMenu.hidden = true;
    modelToggle?.setAttribute("aria-expanded", "false");
    familyToggles.forEach((button) => button.setAttribute("aria-expanded", "false"));
    effortMenus.forEach((menu) => menu.setAttribute("aria-hidden", "true"));
    if (restoreFocus) modelToggle?.focus();
  };
  const openFamilyMenu = (family, focusFirst = false) => {
    const familyToggle = familyToggles.find((button) => button.dataset.brunchModelFamilyToggle === family);
    const effortMenu = effortMenus.find((menu) => menu.dataset.brunchEffortMenu === family);
    if (!familyToggle || !effortMenu) return;
    familyToggles.forEach((button) => button.setAttribute("aria-expanded", String(button === familyToggle)));
    effortMenus.forEach((menu) => menu.setAttribute("aria-hidden", String(menu !== effortMenu)));
    if (focusFirst) effortMenu.querySelector("[data-brunch-model-preset]")?.focus();
  };
  const moveFamilyFocus = (button, direction) => {
    const index = familyToggles.indexOf(button);
    if (index < 0 || familyToggles.length === 0) return;
    const next = (index + direction + familyToggles.length) % familyToggles.length;
    familyToggles[next]?.focus();
  };
  modelToggle?.addEventListener("click", () => {
    if (!modelMenu || modelToggle.disabled) return;
    const open = modelMenu.hidden;
    modelMenu.hidden = !open;
    modelToggle.setAttribute("aria-expanded", String(open));
    if (!open) closeModelMenu();
  });
  modelToggle?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      if (modelToggle.disabled) return;
      event.preventDefault();
      if (modelMenu?.hidden) {
        modelMenu.hidden = false;
        modelToggle.setAttribute("aria-expanded", "true");
      }
      familyToggles[0]?.focus();
    } else if (event.key === "Escape" && modelMenu && !modelMenu.hidden) {
      event.preventDefault();
      closeModelMenu(true);
    }
  });
  familyToggles.forEach((button) => {
    const family = button.dataset.brunchModelFamilyToggle;
    button.addEventListener("mouseenter", () => openFamilyMenu(family));
    button.addEventListener("focusin", () => openFamilyMenu(family));
    button.addEventListener("click", () => openFamilyMenu(family, true));
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFamilyMenu(family, true);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFamilyFocus(button, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFamilyFocus(button, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        familyToggles[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        familyToggles.at(-1)?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeModelMenu(true);
      }
    });
  });
  modelMenu?.querySelectorAll("[data-brunch-model-preset]").forEach((button) => {
    const effortMenu = button.closest("[data-brunch-effort-menu]");
    button.addEventListener("keydown", (event) => {
      const effortButtons = [...(effortMenu?.querySelectorAll("[data-brunch-model-preset]") ?? [])];
      const index = effortButtons.indexOf(button);
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        effortButtons[(index + 1) % effortButtons.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        effortButtons[(index - 1 + effortButtons.length) % effortButtons.length]?.focus();
      } else if (event.key === "ArrowLeft" || event.key === "Escape") {
        event.preventDefault();
        if (event.key === "Escape") closeModelMenu(true);
        else effortMenu?.parentElement?.querySelector("[data-brunch-model-family-toggle]")?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        effortButtons[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        effortButtons.at(-1)?.focus();
      }
    });
    button.addEventListener("click", () => {
      closeModelMenu();
      context.onChatModelSelect?.(button.dataset.brunchModelPreset);
    });
  });
}

function renderBrunchChatCenter(context, chat) {
  renderBrunchChatConversation(context, chat);
  renderBrunchChatUserInput(context, chat);
}

function renderCenter(context, viewModel) {
  const selectionRevealPending = context.getSelectionRevealPending?.() ?? false;
  const optionMarkup = renderCenterOptions(viewModel, { revealPending: selectionRevealPending });
  const notice = context.getWorkflowNotice?.();
  const isGenerating = context.getIsGenerating?.() ?? false;
  const workflowCompleted = context.getWorkflowCompleted?.() ?? false;
  const selectionMarkup = workflowCompleted
    ? `<div class="center-selection workflow-complete-selection">
        <p class="choice-title">Writing Section</p>
        <div class="completion-card">
          <span class="completion-check" aria-hidden="true">✓</span>
          <div><strong>최종 패키지 작성 완료</strong><p>최종 패키지를 Markdown 파일로 내보냈습니다.</p></div>
        </div>
      </div>`
    : `<div class="center-selection">
    <p class="choice-title">${escapeHtml(viewModel.ui.title ?? "현재 응답")}</p>
    <div class="center-option-scroll-shell">
      <div class="center-option-scroll">
        ${optionMarkup || `<div class="center-empty">${escapeHtml(viewModel.ui.description ?? "이 단계는 오른쪽 패널에서 검토합니다.")}</div>`}
        ${notice ? `<p class="workflow-notice ${escapeHtml(notice.type ?? "info")}">${escapeHtml(notice.message)}</p>` : ""}
      </div>
      <div class="center-scrollbar" aria-hidden="true"><span></span></div>
    </div>
    <div class="composer">
      <label class="free-revise">
        <b>✎</b>
        <textarea rows="2" placeholder="아니오 Codex가 뭘 할지 말씀해주세요."></textarea>
      </label>
      ${renderActions(viewModel)}
    </div>
  </div>`;
  const generationSelectionMarkup = selectionMarkup.replace(
    'class="center-selection',
    'class="center-selection generation-selection-reserve'
  ).replace(
    '<div class="center-selection generation-selection-reserve',
    '<div class="center-selection generation-selection-reserve" aria-hidden="true"'
  );
  context.nodes.center.innerHTML = `<div class="panel-title-row">
    <h1>Conversation</h1>
    <span class="model-pill">GPT 5.6 Luna</span>
  </div>
  <div class="message-stack">
    ${renderConversationMessages(context, viewModel)}
  </div>
  ${isGenerating
    ? `${generationSelectionMarkup}<div class="generation-controls"><button class="stop-generation-button" type="button"><span aria-hidden="true"></span>중단</button></div>`
    : selectionMarkup}`;

  context.nodes.center.querySelectorAll("[data-option-id]").forEach((button) => {
    button.addEventListener("click", () => {
      context.nodes.center.querySelectorAll("[data-option-id]").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
      if (viewModel.step === "track_selection" && !isGenerating) context.onContinue();
    });

    button.addEventListener("dblclick", () => {
      if (viewModel.step === "track_selection") return;
      if (isGenerating) return;
      if (!button.classList.contains("selected")) return;
      context.onContinue();
    });
  });

  const optionScroll = context.nodes.center.querySelector(".center-option-scroll");
  const optionScrollShell = context.nodes.center.querySelector(".center-option-scroll-shell");
  const customThumb = context.nodes.center.querySelector(".center-scrollbar span");
  if (optionScroll && optionScrollShell && customThumb) {
    let scrollTimer = null;

    const updateCustomScrollbar = () => {
      const scrollHeight = optionScroll.scrollHeight;
      const clientHeight = optionScroll.clientHeight;
      const maxScrollTop = scrollHeight - clientHeight;

      if (maxScrollTop <= 1) {
        optionScrollShell.classList.add("no-scroll");
        return;
      }

      optionScrollShell.classList.remove("no-scroll");

      const trackHeight = clientHeight - 8;
      const thumbHeight = Math.max(32, Math.round((clientHeight / scrollHeight) * trackHeight));
      const maxThumbTop = trackHeight - thumbHeight;
      const thumbTop = Math.round((optionScroll.scrollTop / maxScrollTop) * maxThumbTop);

      customThumb.style.height = `${thumbHeight}px`;
      customThumb.style.transform = `translateY(${thumbTop}px)`;
    };

    updateCustomScrollbar();

    optionScroll.addEventListener("scroll", () => {
      optionScrollShell.classList.add("is-scrolling");
      updateCustomScrollbar();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        optionScrollShell.classList.remove("is-scrolling");
      }, 900);
    });

    requestAnimationFrame(updateCustomScrollbar);
  }

  const freeReviseTextarea = context.nodes.center.querySelector(".free-revise textarea");
  if (freeReviseTextarea) {
    freeReviseTextarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (event.isComposing) return;
      if (event.shiftKey) return;
      event.preventDefault();
      if (isGenerating) return;
      context.onContinue();
    });
  }

  const continueButton = context.nodes.center.querySelector(".continue-button");
  if (continueButton) {
    continueButton.disabled = isGenerating;
    continueButton.addEventListener("click", context.onContinue);
  }

  context.nodes.center.querySelector(".stop-generation-button")?.addEventListener("click", context.onStop);
}

function bindSourceSelectionCards(context) {
  const root = context.nodes.right.querySelector("[data-source-selection-root]");
  if (!root || root.dataset.sourceEventsBound === "true") return;
  root.dataset.sourceEventsBound = "true";

  const searchForm = () => root.querySelector("[data-source-search-form]");
  const searchInput = () => searchForm()?.querySelector("[name=query]");
  const syncSearchInput = () => {
    const input = searchInput();
    const row = input?.closest(".source-search-row");
    const submit = searchForm()?.querySelector(".source-search-submit");
    const hasQuery = Boolean(String(input?.value ?? "").trim());
    row?.classList.toggle("has-query", hasQuery);
    if (submit) submit.disabled = !hasQuery;
  };
  const readSearchForm = () => {
    const form = searchForm();
    if (!form) return { query: "", status: "all", filters: {} };
    const values = new FormData(form);
    return {
      query: String(values.get("query") ?? ""),
      status: String(values.get("status") ?? "all"),
      filters: {
        topic: String(values.get("topic") ?? "all"),
        reliability: String(values.get("reliability") ?? "all"),
        source: String(values.get("source") ?? "all"),
        sort: String(values.get("sort") ?? "latest")
      }
    };
  };
  const resetSearchForm = () => {
    const form = searchForm();
    const input = searchInput();
    if (input) input.value = "";
    form?.querySelectorAll("[data-source-filter]").forEach((filter) => {
      filter.value = filter.dataset.sourceFilter === "status" ? "all" : filter.dataset.sourceFilter === "sort" ? "latest" : "all";
    });
    syncSearchInput();
  };
  const detailModal = () => root.querySelector("[data-research-detail-modal]");
  const selectedChoice = (selector) => detailModal()?.querySelector(`${selector}.is-selected`);

  root.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-source-search-form]");
    if (!form) return;
    event.preventDefault();
    context.onSourceSearch?.(readSearchForm());
  });

  root.addEventListener("input", (event) => {
    if (event.target.matches("[name=query]")) syncSearchInput();
  });

  root.addEventListener("change", (event) => {
    if (event.target.matches("[data-source-filter]")) {
      context.onSourceFilter?.(readSearchForm());
      return;
    }
    if (!event.target.matches("[data-source-id] input[type=checkbox]")) return;
    const card = event.target.closest("[data-source-id]");
    if (!card || event.target.disabled) return;
    context.onSourceSelectionChange?.(card.dataset.sourceKind, card.dataset.sourceId, event.target.checked);
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && detailModal()) {
      context.onResearchDetailClose?.();
      return;
    }
    if (!event.target.matches("[data-research-evidence-status-choice]")) return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const choices = [...root.querySelectorAll("[data-research-evidence-status-choice]")];
    const index = choices.indexOf(event.target);
    choices[(index + (event.key === "ArrowRight" ? 1 : -1) + choices.length) % choices.length]?.focus();
  });

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) {
      if (button.matches("[data-source-search-clear]")) {
        event.preventDefault();
        const input = searchInput();
        if (input) input.value = "";
        syncSearchInput();
        context.onSourceSearch?.(readSearchForm());
        return;
      }
      if (button.matches("[data-source-search-reset-all]")) {
        event.preventDefault();
        resetSearchForm();
        context.onSourceSearch?.({ query: "", status: "all", filters: { topic: "all", reliability: "all", source: "all", sort: "latest" } });
        return;
      }
      if (button.matches("[data-source-search-reset], [data-source-search-retry]")) {
        event.preventDefault();
        resetSearchForm();
        context.onSourceSearch?.(readSearchForm());
        return;
      }
      if (button.matches("[data-source-load-more]")) {
        event.preventDefault();
        context.onSourceLoadMore?.();
        return;
      }
      if (button.matches("[data-source-clear-selection]")) {
        event.preventDefault();
        context.onSourceClear?.();
        return;
      }
      if (button.matches("[data-source-replace]")) {
        event.stopPropagation();
        button.closest(".source-selection-recommended")?.removeAttribute("open");
        context.onSourceRemove?.(button.dataset.sourceReplaceKind ?? "document", button.dataset.sourceReplace ?? "");
        return;
      }
      if (button.matches("[data-source-research-cta]")) {
        event.preventDefault();
        if (!button.disabled) context.onResearchRequest?.({ query: button.dataset.researchQuery ?? "" });
        return;
      }
      if (button.matches("[data-source-research-retry]")) {
        event.preventDefault();
        context.onResearchRequest?.({ query: context.getSourceSelection?.().query ?? "", jobId: button.dataset.researchJobId ?? "", retry: true });
        return;
      }
      if (button.matches("[data-research-detail]")) {
        event.stopPropagation();
        context.onResearchDetail?.(button.dataset.researchDetail);
        return;
      }
      if (button.matches("[data-source-detail-document]")) {
        event.stopPropagation();
        context.onSourceDocumentDetail?.(button.dataset.sourceDetailDocument);
        return;
      }
      if (button.matches("[data-research-source-detail]")) {
        event.stopPropagation();
        context.onResearchSourceDetail?.(button.dataset.researchSourceDetail);
        return;
      }
      if (button.matches("[data-source-remove]")) {
        event.stopPropagation();
        context.onSourceRemove?.(button.dataset.sourceRemove, button.dataset.sourceRemoveId);
        return;
      }
      if (button.matches("[data-research-source-review]")) {
        event.stopPropagation();
        context.onResearchSourceReview?.({ source_id: button.dataset.researchSourceId, decision: button.dataset.researchSourceReview, reliability: button.dataset.researchSourceReliability ?? "" });
        return;
      }
      if (button.matches("[data-research-source-confidence-save]")) {
        event.stopPropagation();
        const sourceId = button.dataset.researchSourceId;
        const reliability = root.querySelector(`[data-research-source-reliability="${CSS.escape(sourceId ?? "")}"]`)?.value ?? "medium";
        context.onResearchSourceReview?.({ source_id: sourceId, decision: "needs_context", reliability });
        return;
      }
      if (button.matches("[data-research-evidence-status-choice]")) {
        const status = button.dataset.researchEvidenceStatusChoice ?? "pending";
        root.querySelectorAll("[data-research-evidence-status-choice]").forEach((choice) => {
          const selected = choice.dataset.researchEvidenceStatusChoice === status;
          choice.classList.toggle("is-selected", selected);
          choice.setAttribute("aria-pressed", String(selected));
        });
        return;
      }
      if (button.matches("[data-research-evidence-confidence-choice]")) {
        const confidence = button.dataset.researchEvidenceConfidenceChoice ?? "";
        root.querySelectorAll("[data-research-evidence-confidence-choice]").forEach((choice) => {
          const selected = choice.dataset.researchEvidenceConfidenceChoice === confidence;
          choice.classList.toggle("is-selected", selected);
          choice.setAttribute("aria-pressed", String(selected));
        });
        return;
      }
      if (button.matches("[data-research-source-reliability-choice]")) {
        const reliability = button.dataset.researchSourceReliabilityChoice ?? "medium";
        root.querySelectorAll("[data-research-source-reliability-choice]").forEach((choice) => {
          const selected = choice.dataset.researchSourceReliabilityChoice === reliability;
          choice.classList.toggle("is-selected", selected);
          choice.setAttribute("aria-pressed", String(selected));
        });
        return;
      }
      if (button.matches("[data-research-evidence-save]")) {
        const confidenceValue = selectedChoice("[data-research-evidence-confidence-choice]")?.dataset.researchEvidenceConfidenceChoice ?? "";
        context.onResearchReview?.({
          evidence_id: button.dataset.researchEvidenceId,
          decision: selectedChoice("[data-research-evidence-status-choice]")?.dataset.researchEvidenceStatusChoice ?? "pending",
          confidence: confidenceValue === "" ? null : Number(confidenceValue),
          reliability: confidenceValue === "0.9" ? "high" : confidenceValue === "0.6" ? "medium" : confidenceValue === "0.3" ? "low" : ""
        });
        return;
      }
      if (button.matches("[data-research-source-save]")) {
        context.onResearchSourceReview?.({
          source_id: button.dataset.researchSourceId,
          decision: selectedChoice("[data-research-evidence-status-choice]")?.dataset.researchEvidenceStatusChoice ?? "pending",
          reliability: selectedChoice("[data-research-source-reliability-choice]")?.dataset.researchSourceReliabilityChoice ?? "medium"
        });
        return;
      }
      if (button.matches("[data-research-detail-cancel], [data-research-source-cancel], [data-research-detail-close], [data-research-detail-close]")) {
        event.stopPropagation();
        context.onResearchDetailClose?.();
        return;
      }
    }

    if (event.target.matches("[data-research-detail-modal]")) {
      context.onResearchDetailClose?.();
      return;
    }

    const card = event.target.closest("[data-source-id]");
    if (!card || event.target.closest("button, a, label, input")) return;
    if (context.getIsGenerating?.()) return;
    const checkbox = card.querySelector("input[type=checkbox]");
    if (checkbox?.disabled) return;
    context.onSourceSelectionChange?.(card.dataset.sourceKind, card.dataset.sourceId, !card.classList.contains("selected"));
  });

  syncSearchInput();
}

function tagList(tags = [], variant = "") {
  return tags.map((tag) => `<span class="${variant}">${escapeHtml(tag)}</span>`).join("");
}

function renderNavigation(context, viewModel) {
  if (viewModel.step === "source_selection") return "";
  const timeline = context.getTimeline();
  return `<div class="right-nav" aria-label="Response navigation">
    <button class="nav-step" type="button" data-nav="previous" aria-label="Previous response" ${timeline.canGoPrevious ? "" : "disabled"}>‹</button>
    <b>${viewModel.turn} / ${viewModel.totalTurns}</b>
    <button class="nav-step" type="button" data-nav="next" aria-label="Next response" ${timeline.canGoNext ? "" : "disabled"}>›</button>
  </div>`;
}

function renderOptionPanel(viewModel) {
  const options = viewModel.ui.options ?? [];
  const [main, ...secondary] = options;
  const mainReason = String(viewModel.recommendationReason || main?.reason || "").trim();
  return `<article class="selected-topic-card">
      <p>${escapeHtml(viewModel.stepLabel)}</p>
      <div>
        <h3>${escapeHtml(viewModel.ui.title ?? viewModel.stepLabel)}</h3>
        <span>${escapeHtml(viewModel.ui.description ?? "")}</span>
      </div>
    </article>
    <section class="recommend-block">
      <p>추천 항목</p>
      <div class="recommend-list">
        ${
          main
            ? `<article class="main-recommend selected">
          <span class="ai-label">AI 추천 1순위</span>
          <div class="main-copy">
            <h3>${escapeHtml(main.title)}</h3>
            <p>${escapeHtml(main.description ?? main.reason ?? "")}</p>
            <div class="tag-row">${tagList(main.tags, "primary")}</div>
          </div>
          ${mainReason ? `<div class="reason-box"><span>추천 이유</span><p>${escapeHtml(mainReason)}</p></div>` : ""}
        </article>`
            : ""
        }
        <div class="secondary-list">
          ${secondary
            .map((item, index) => {
              return `<article class="sub-recommend">
              <span class="ai-label">후보 ${index + 2}</span>
              <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description ?? item.reason ?? "")}</p></div>
              <div class="tag-row">${tagList(item.tags)}</div>
            </article>`;
            })
            .join("")}
        </div>
      </div>
    </section>`;
}

function renderFactDetail(viewModel) {
  const facts = factCheckItems(viewModel);
  if (facts.length === 0) return "";
  return `<section class="fact-detail">
      <p>확인 필요 항목 (Fact-check)</p>
      <div class="right-fact-list">
        ${facts.map((item) => factMarkup(item, viewModel)).join("")}
      </div>
    </section>`;
}

function renderRight(context, viewModel) {
  context.nodes.right.setAttribute("aria-label", "Topic Refinement");
  const rightRevealPending = context.getRightRevealPending?.() ?? false;
  let body = "";
  try {
    body = viewModel.ui.component === "option_grid" ? renderOptionPanel(viewModel) : renderCurrentStep(viewModel);
  } catch (error) {
    body = `<div class="unknown-component">${escapeHtml(error.message)}</div>`;
  }
  context.nodes.right.innerHTML = `<div class="right-title-row">
    <h2>${escapeHtml(viewModel.stepLabel)}</h2>
    ${renderNavigation(context, viewModel)}
  </div>
  <div class="right-scroll${rightRevealPending ? " right-content-reveal-pending" : ""}${viewModel.step === "source_selection" ? " source-selection-right-scroll" : ""}">
    ${body}
    ${renderFactDetail(viewModel)}
  </div>`;
  bindSourceSelectionCards(context);
  context.nodes.right.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", context.onNavigate));
}

export function createPanelController(context) {
  const sourceSelectionView = createSourceSelectionViewController();
  return {
    render(viewModel) {
      if (context.getMode?.() === "brunch-chat") {
        context.nodes.left.innerHTML = "";
        renderBrunchChatCenter(context, context.getBrunchChat?.() ?? {});
        return;
      }
      renderLeft(context, viewModel);
      renderCenter(context, viewModel);
      renderRight(context, viewModel);
    },
    updateSourceSelection(viewModel, options = {}) {
      if (viewModel.step !== "source_selection" || !sourceSelectionView.update(viewModel, options)) {
        this.render(viewModel);
      }
    }
  };
}
