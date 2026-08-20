import { escapeHtml, renderReadOnlySourceCard } from "./renderers.js";
import { V06_OPERATOR_COPY } from "./v06-operator-copy.js";
import { copyCatalog } from "../copy-catalog.js";

const esc = (value) => escapeHtml(value ?? "");

function startFieldError(errors, name) {
  const value = errors?.[name];
  return value ? `<p class="v06-start-field-error" id="v06-start-${esc(name)}-error">${esc(value)}</p>` : "";
}

function startLines(value) {
  return String(value ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function startDepthLabel(value, copy) {
  return ({ light: copy.depthLight, standard: copy.depthStandard, deep: copy.depthDeep }[value] ?? "—");
}

function renderStartSummary(values, copy) {
  const seedUrls = startLines(values.seed_urls);
  const min = String(values.source_count_min ?? "").trim();
  const preferred = String(values.source_count_preferred ?? "").trim();
  const max = String(values.source_count_max ?? "").trim();
  const targetCount = [min, preferred, max].every(Boolean) ? `${min} / ${preferred} / ${max}` : "—";
  const interest = String(values.initial_interest ?? "").trim();
  return `<p>${esc(V06_OPERATOR_COPY.start.contextDescription)}</p><dl class="v06-start-summary-list">
    <dt>${esc(copy.subject)}</dt><dd>${esc(String(values.subject ?? "").trim() || "—")}</dd>
    <dt>${esc(copy.seedUrls)}</dt><dd>${seedUrls.length ? `${seedUrls.length}개` : "—"}</dd>
    <dt>${esc(copy.researchDepth)}</dt><dd>${esc(startDepthLabel(values.research_depth, copy))}</dd>
    <dt>${esc(copy.targetSourceCount)}</dt><dd>${esc(targetCount)}</dd>
    ${interest ? `<dt>${esc(copy.initialInterest)}</dt><dd>${esc(interest.length > 140 ? `${interest.slice(0, 140).trimEnd()}…` : interest)}</dd>` : ""}
  </dl>`;
}

export function renderV06Start(context) {
  const { nodes, state } = context;
  nodes.center.classList?.remove?.("v06-editing");
  const copy = copyCatalog.newArticle;
  const draft = state.start?.draft ?? {};
  const errors = state.start?.errors ?? {};
  const status = state.start?.status ?? "idle";
  const busy = status === "loading";
  const counts = [draft.source_count_min, draft.source_count_preferred, draft.source_count_max].map(Number);
  const clientReady = Boolean(String(draft.subject ?? "").trim())
    && counts.every((value) => Number.isInteger(value) && value >= 1 && value <= 100)
    && counts[0] <= counts[1] && counts[1] <= counts[2];
  const disabled = busy ? "disabled" : "";
  const describedBy = (name) => errors[name] ? `aria-describedby="v06-start-${name}-error"` : "";
  const startSteps = Object.entries(V06_OPERATOR_COPY.steps).map(([id, label], index) => `<button type="button" class="step-row pending" data-v06-start-step="${esc(id)}" disabled><span>${index + 1}</span><p>${esc(label)}</p><small>${esc(V06_OPERATOR_COPY.states.pending)}</small></button>`).join("");
  nodes.left.innerHTML = `<div class="rail-section v06-start-rail"><div class="rail-head"><p class="eyebrow">${esc(V06_OPERATOR_COPY.start.railTitle)}</p><p>${esc(V06_OPERATOR_COPY.start.railDescription)}</p></div><div class="step-list">${startSteps}</div></div><div class="state-card v06-start-state"><p class="eyebrow">현재 상태</p><ul><li><span>진행 단계</span><b>새 글 설정</b></li><li><span>다음 단계</span><b>자료 검토</b></li></ul></div>`;
  nodes.center.innerHTML = `<section class="v06-start-stage" aria-labelledby="v06-start-title"><div class="v06-panel-title"><div><h1 id="v06-start-title">${esc(copy.title)}</h1></div><span class="model-pill">v0.6</span></div><form class="v06-start-form" data-v06-start-form novalidate>
    <label>${esc(copy.subject)}<input name="subject" required value="${esc(draft.subject)}" ${describedBy("subject")} ${disabled} /></label>${startFieldError(errors, "subject")}
    <label>${esc(copy.seedUrls)}<textarea name="seed_urls" rows="3" ${describedBy("seed_urls")} ${disabled}>${esc(draft.seed_urls)}</textarea><small>${esc(V06_OPERATOR_COPY.start.seedUrlsHint)}</small></label>${startFieldError(errors, "seed_urls")}
    <label>${esc(copy.initialInterest)}<textarea name="initial_interest" rows="2" ${disabled}>${esc(draft.initial_interest)}</textarea></label>
    <label>${esc(copy.comparisonHints)}<textarea name="comparison_hints" rows="2" ${disabled}>${esc(draft.comparison_hints)}</textarea><small>${esc(V06_OPERATOR_COPY.start.comparisonHintsHint)}</small></label>
    <label>${esc(copy.editorNotes)}<textarea name="editor_notes" rows="2" ${disabled}>${esc(draft.editor_notes)}</textarea></label>
    <label>${esc(copy.researchDepth)}<select name="research_depth" ${disabled}><option value="light" ${draft.research_depth === "light" ? "selected" : ""}>${esc(copy.depthLight)}</option><option value="standard" ${draft.research_depth !== "light" && draft.research_depth !== "deep" ? "selected" : ""}>${esc(copy.depthStandard)}</option><option value="deep" ${draft.research_depth === "deep" ? "selected" : ""}>${esc(copy.depthDeep)}</option></select></label>
    <fieldset ${disabled}><legend>${esc(copy.targetSourceCount)}</legend><div class="v06-start-counts"><label>최소<input name="source_count_min" inputmode="numeric" type="number" min="1" value="${esc(draft.source_count_min ?? "")}" ${describedBy("target_source_count")} /></label><label>권장<input name="source_count_preferred" inputmode="numeric" type="number" min="1" value="${esc(draft.source_count_preferred ?? "")}" ${describedBy("target_source_count")} /></label><label>최대<input name="source_count_max" inputmode="numeric" type="number" min="1" value="${esc(draft.source_count_max ?? "")}" ${describedBy("target_source_count")} /></label></div><small>${esc(V06_OPERATOR_COPY.start.sourceCountHint)}</small></fieldset>${startFieldError(errors, "target_source_count")}
    <div class="v06-start-actions"><button class="v06-action-button primary" data-v06-start-submit type="submit" ${busy || !clientReady ? "disabled" : ""}>${esc(busy ? copy.loading : copy.start)}</button>${status === "error" ? `<button class="v06-action-button secondary" type="submit" ${disabled}>${esc(copy.retry)}</button>` : ""}</div><p class="v06-start-status" aria-live="polite">${status === "loading" ? esc(copy.loading) : status === "success" ? esc(copy.success) : esc(state.start?.message ?? "")}</p>
  </form></section>`;
  nodes.right.innerHTML = `<div class="v06-context-panel"><div class="right-title-row"><h2>${esc(V06_OPERATOR_COPY.start.contextTitle)}</h2></div><div class="right-scroll v06-context-scroll"><div class="v06-context-content" data-v06-start-summary>${renderStartSummary(draft, copy)}</div></div></div>`;
  const form = nodes.center.querySelector("[data-v06-start-form]");
  const updateSubmitAvailability = () => {
    const submit = form?.querySelector("[data-v06-start-submit]");
    if (!submit || busy) return;
    const values = new FormData(form);
    const countValues = ["source_count_min", "source_count_preferred", "source_count_max"].map((name) => Number(values.get(name)));
    submit.disabled = !String(values.get("subject") ?? "").trim()
      || !countValues.every((value) => Number.isInteger(value) && value >= 1 && value <= 100)
      || countValues[0] > countValues[1] || countValues[1] > countValues[2];
  };
  const updateStartSummary = () => {
    const summary = nodes.right.querySelector("[data-v06-start-summary]");
    if (!summary || !form) return;
    summary.innerHTML = renderStartSummary(Object.fromEntries(new FormData(form).entries()), copy);
  };
  form?.addEventListener("input", updateSubmitAvailability);
  form?.addEventListener("input", updateStartSummary);
  form?.addEventListener("change", updateSubmitAvailability);
  form?.addEventListener("change", updateStartSummary);
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!busy) context.onSubmit(new FormData(event.currentTarget));
  });
}

function stageLabel(id) {
  return V06_OPERATOR_COPY.steps[id] ?? id;
}

function resolveV06OperatorStep(step) {
  return step === "research_scope" ? "research_review" : step || "research_review";
}

function stateLabel(code) {
  if (["blocked", "failed", "stale"].includes(code)) return code === "stale" ? "이전 결과 변경됨" : "수정 필요";
  if (["review_required", "composition_reviewing", "structural_reviewing"].includes(code)) return "검토 필요";
  if (["running", "research_running", "composition_running", "structural_editing"].includes(code) || String(code ?? "").endsWith("_running")) return "작업 중";
  if (String(code ?? "").endsWith("_reviewing")) return "검토 필요";
  if (code === "ready_to_research") return "조사 시작 대기";
  if (code === "ready_to_run") return "다음 단계 실행 대기";
  if (code === "writing_package_ready" || code === "metadata_ready") return "다음 단계 실행 대기";
  return V06_OPERATOR_COPY.states[code] ?? "확인 필요";
}

function evidenceLabel(value) {
  if (value === "direct" || value === "direct_evidence") return "직접 근거";
  if (value === "discovery_only") return "참고용";
  return "맥락 근거";
}

function qualityLabel(value) {
  if (value === "full_text") return "원문 확인 가능";
  if (value === "title_only") return "제목만 확인";
  return "일부 문맥 확인";
}

function sourceKindLabel(value) {
  const labels = { official: "공식 자료", primary: "1차 자료", independent_analysis: "독립 분석", interview: "인터뷰", comparison: "비교 자료" };
  return labels[value] ?? "자료";
}

function conversationSourceLabel(entry, index) {
  const publisher = String(entry?.publisher ?? entry?.publisher_name ?? "").trim();
  const kind = sourceKindLabel(entry?.source_kind);
  const descriptor = publisher || kind;
  return `자료 ${index + 1} · ${compactText(descriptor, 24)}`;
}

function conversationFindingType(value) {
  const labels = {
    repeated_pattern: "반복된 변화",
    contrast: "자료 사이의 차이",
    contradiction: "충돌하는 관점",
    unexpected_connection: "예상 밖의 연결",
    common_coverage: "흔한 방향",
    underexplored_angle: "덜 다뤄진 방향",
    open_question: "남은 질문",
    evidence_gap: "근거 공백",
    single_source_signal: "한 자료의 신호",
    lexical_signal: "참고 신호"
  };
  return labels[value] ?? "자료에서 발견한 관계";
}

function publisherTypeLabel(value) {
  const labels = {
    official_issuer: "발행 주체 공식 자료",
    news_media: "뉴스·미디어",
    professional_platform: "전문가 플랫폼",
    industry_publication: "업계 매체",
    personal_blog: "개인·블로그",
    aggregator: "모음 자료",
    academic: "연구 자료"
  };
  return labels[value] ?? "발행처 확인 필요";
}

function authorityLabel(value) {
  const labels = {
    primary: "1차 자료",
    independent_expert: "직접 발언·전문가 자료",
    secondary_analysis: "2차 분석",
    anecdotal: "개인 사례",
    discovery_only: "참고용 발견 자료"
  };
  return labels[value] ?? "권위 확인 필요";
}

function claimSupportLabel(value) {
  const labels = {
    directly_supported: "직접 뒷받침",
    supported_inference: "제한적 합성 가능",
    insufficient: "근거 부족"
  };
  return labels[value] ?? "확인 필요";
}

function archetypeLabel(value) {
  const labels = { strategy_interpretation: "전략 해석", change_comparison: "변화 비교", mechanism_explanation: "작동 방식 설명", practical_translation: "실무적 해석", industry_outlook: "산업 전망", critical_limit: "한계 비평" };
  return labels[value] ?? "글의 방향";
}

function roleLabel(value) {
  const labels = { context: "맥락", problem: "문제", primary_evidence: "핵심 근거", comparison: "비교", synthesis: "합성 해석", counterpoint: "반대 관점", interpretation: "해석", implication: "의미", conclusion: "결론" };
  return labels[value] ?? "주장";
}

function coverageLabel(value) {
  const labels = { normal: "조사 범위 확보", sufficient: "조사 범위 확보", partial: "일부 관점 부족", restricted: "검토 범위 제한", missing: "확인이 필요한 관점 있음" };
  return labels[value] ?? "확인 필요";
}

function laneLabel(value) {
  const labels = {
    official: "공식·1차 자료",
    historical: "이전 맥락",
    independent: "독립 분석",
    official_tools: "도구 기업 공식 자료",
    hiring_evaluators: "채용자·디자인 리더",
    hiring_evaluation_criteria: "채용 평가 기준",
    evaluation_criteria_change: "평가 기준 변화",
    portfolio_process: "포트폴리오 과정·실패 사례",
    portfolio_process_evidence: "포트폴리오 과정·실패 사례",
    prototyping_cost: "AI 프로토타이핑 비용",
    counterpoint: "완성도·실행 능력의 반대 관점",
    portfolio_quality_and_execution: "완성도·실행 능력",
    seniority: "주니어·시니어 평가 차이",
    comparison: "비교 자료",
    critique: "비판적 관점"
  };
  return labels[value] ?? "조사 관점";
}

function issueText(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text || /^[a-z_]+(?:_[a-z_]+)+$/u.test(text) || /^recommended_route:/u.test(text)) return fallback;
  return text;
}

function markdownPreview(markdown) {
  const value = String(markdown ?? "");
  return value
    .split(/\n{2,}/u)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("### ")) return `<h3>${esc(trimmed.slice(4))}</h3>`;
      if (trimmed.startsWith("## ")) return `<h2>${esc(trimmed.slice(3))}</h2>`;
      if (trimmed.startsWith("> ")) return `<blockquote>${esc(trimmed.slice(2))}</blockquote>`;
      return `<p>${esc(trimmed).replaceAll("\n", "<br />")}</p>`;
    })
    .join("");
}

function highlightedMarkdown(markdown, issues = []) {
  const excerpt = issues.find((issue) => issue.draft_excerpt)?.draft_excerpt;
  if (!excerpt) return markdownPreview(markdown);
  const raw = String(markdown ?? "");
  const index = raw.indexOf(excerpt);
  if (index < 0) return markdownPreview(raw);
  const before = raw.slice(0, index);
  const after = raw.slice(index + excerpt.length);
  return `${markdownPreview(before)}<p class="v06-issue-sentence"><mark>${esc(excerpt)}</mark></p>${markdownPreview(after)}`;
}

function compactDraftMarkdown(markdown, maxLength = 300) {
  const blocks = String(markdown ?? "").split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) return "";
  let result = "";
  for (const block of blocks) {
    const candidate = result ? `${result}\n\n${block}` : block;
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  if (!result) result = blocks[0].slice(0, maxLength).trimEnd();
  return result.length < String(markdown ?? "").trim().length ? `${result}…` : result;
}

function redactProviderEvidence(markdown) {
  return String(markdown ?? "").replace(/\s*\(근거:\s*[^)\n]*#[^)\n]*\)/gu, "");
}

function draftDiff(before, after) {
  if (before === after) return "변경 없음";
  const oldLines = String(before ?? "").split("\n");
  const newLines = String(after ?? "").split("\n");
  const length = Math.max(oldLines.length, newLines.length);
  const lines = [];
  for (let index = 0; index < length; index += 1) {
    if (oldLines[index] === newLines[index]) {
      if (oldLines[index] !== undefined) lines.push(`  ${oldLines[index]}`);
      continue;
    }
    if (oldLines[index] !== undefined) lines.push(`- ${oldLines[index]}`);
    if (newLines[index] !== undefined) lines.push(`+ ${newLines[index]}`);
  }
  return lines.join("\n");
}

function actionButtons(actions = [], artifactId = null) {
  const primaryActions = ["approve", "run_next", "run_integrity", "run_structural_edit", "start_research", "expand_research", "reassess_research"];
  return actions.map((item) => `<button type="button" class="v06-action-button ${(item.primary ?? primaryActions.includes(item.action)) ? "primary" : "secondary"}" data-v06-action="${esc(item.action)}" data-v06-task="${esc(item.task ?? "")}" data-v06-artifact-id="${esc(artifactId ?? "")}">${esc(item.label)}</button>`).join("");
}

function compactText(value, maxLength = 150) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

function firstPublishValue(payload, key, fallback = "") {
  const value = payload?.[key];
  if (Array.isArray(value)) return value.find((item) => String(item ?? "").trim()) ?? fallback;
  return String(value ?? "").trim() || fallback;
}

function conversationPrompt(step, operator, state) {
  if (step === "research_review") {
    const executionState = operator.runtime_view?.execution_state;
    const activeRun = (operator.active_runs ?? []).find((run) => run.task_type === "start_research");
    if (executionState === "failed") {
      return "자료 조사가 멈췄습니다. 입력한 범위는 보존되어 아래에서 다시 시도할 수 있습니다.";
    }
    if (state?.busy || executionState === "research_running" || activeRun) {
      return "자료 조사를 진행하고 있습니다. 입력한 범위에 맞는 자료를 확인하는 동안 잠시 기다려주세요. 조사가 끝나면 이 화면에 자료 검토 선택지가 나타납니다.";
    }
    if (!operator.research.artifact && operator.runtime_view?.next_action === "start_research") {
      return `${V06_OPERATOR_COPY.research.readyTitle} ${V06_OPERATOR_COPY.research.readyDescription} 조사가 끝나면 자료를 직접 확인할 수 있습니다.`;
    }
    if (operator.research.artifact && operator.research.editorial_readiness && operator.research.editorial_readiness !== "ready") {
      return V06_OPERATOR_COPY.research.restrictedApproval;
    }
    if (operator.research.artifact) {
      return "자료를 모았습니다. 오른쪽에서 자료 목록과 근거 범위를 확인한 뒤, 다음 진행 방법을 선택하세요.";
    }
  }
  return {
    synthesis_review: "자료에서 발견한 변화",
    editorial_direction_review: "이 자료로 어떤 글을 쓸까요?",
    argument_review: "논증의 흐름",
    writing_review: "글 검토",
    publish_package_review: "발행 전에 마지막으로 확인하세요"
  }[step] ?? "현재 결과를 확인합니다.";
}

function renderConversationMessage(operator, state, step) {
  const prompt = conversationPrompt(step, operator, state);
  return `<article class="message plain topic-message conversation-turn conversation-assistant-turn v06-conversation-message">
    <p>${esc(prompt).replaceAll("\n", "<br />")}</p>
    <div class="topic-chip"><span>${esc(step)}</span>${esc(stageLabel(step))}</div>
  </article>`;
}

function formatResearchRunMeta(run) {
  if (!run) return "실행 상태를 확인하는 중입니다.";
  const startedAt = run.created_at ? new Date(run.created_at) : null;
  const hasStartedAt = startedAt && !Number.isNaN(startedAt.getTime());
  const startedLabel = !hasStartedAt
    ? "시작 시각 확인 필요"
    : `시작 시각 ${startedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;
  const elapsed = hasStartedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : null;
  const elapsedLabel = elapsed === null ? "경과 시간 확인 필요" : `약 ${elapsed}초 경과`;
  return `현재 조사 작업 · 시도 ${Number(run.attempt ?? 1)} · ${startedLabel} · ${elapsedLabel}`;
}

function renderResearchRunProgress(run) {
  const steps = V06_OPERATOR_COPY.research.runningSteps ?? [];
  return `<div class="v06-research-progress" role="status" aria-live="polite"><strong>현재 조사 작업</strong><small>${esc(formatResearchRunMeta(run))}</small><ol>${steps.map((step, index) => `<li class="${index === 0 ? "is-current" : ""}"><span>${index + 1}</span>${esc(step)}</li>`).join("")}</ol></div>`;
}

function renderConversationResearch(operator, state, actions = []) {
  const activeRun = (operator.active_runs ?? []).find((run) => run.task_type === "start_research");
  const failed = operator.runtime_view?.execution_state === "failed";
  const running = state?.busy || operator.runtime_view?.execution_state === "research_running" || Boolean(activeRun);
  const bootstrapNotice = running
    ? `<div class="v06-bootstrap-notice is-running"><p class="thinking-shimmer v06-research-thinking">생각 중</p><h2>${esc(V06_OPERATOR_COPY.research.runningTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.runningDescription)}</p>${renderResearchRunProgress(activeRun)}</div>`
        : failed
        ? `<div class="v06-bootstrap-notice is-failed"><h2>${esc(V06_OPERATOR_COPY.research.failedTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.failedDescription)}</p></div>`
        : "";
  if (running) return `<div class="v06-research-running" role="status" aria-live="polite">${bootstrapNotice}</div>`;
  const options = actions.map((item, index) => `<button type="button" class="center-option center-option-reveal${index === 0 ? " selected" : ""} v06-research-decision-option" data-v06-action="${esc(item.action)}" data-v06-task="${esc(item.task ?? "")}" data-v06-artifact-id="${esc(item.artifact_id ?? "")}"><b>${index + 1}</b><span>${esc(item.label)}</span></button>`).join("");
  const decisionMarkup = options
    ? `<p class="choice-title">${esc(V06_OPERATOR_COPY.research.decisionTitle)}</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${options}</div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div><div class="composer"><label class="free-revise"><b aria-hidden="true">✎</b><textarea rows="2" placeholder="${esc(V06_OPERATOR_COPY.research.freeRevisePlaceholder)}" aria-label="${esc(V06_OPERATOR_COPY.research.freeRevisePlaceholder)}"></textarea></label></div>`
    : (!bootstrapNotice ? `<div class="center-empty">${V06_OPERATOR_COPY.empty}</div>` : "");
  return `<div class="center-selection v06-research-decision-stage">${bootstrapNotice}${decisionMarkup}</div>`;
}

function renderConversationSynthesis(operator, state) {
  const findings = operator.synthesis.findings ?? [];
  const options = findings.map((finding, index) => {
    const label = conversationFindingType(finding.type);
    return `<button type="button" class="center-option center-option-reveal v06-conversation-option ${state.selectedFindingId === finding.finding_id ? "selected" : ""}" title="${esc(finding.text)}" aria-label="${esc(label)}: ${esc(finding.text)}" data-v06-finding="${esc(finding.finding_id)}"><b>${index + 1}</b><span>${esc(`발견 ${index + 1} · ${label}`)}</span></button>`;
  }).join("") || `<div class="center-empty">${V06_OPERATOR_COPY.empty}</div>`;
  return `<div class="center-selection v06-center-selection"><p class="choice-title">자료에서 발견한 변화</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${options}</div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div></div>`;
}

function renderConversationDirection(operator, state) {
  const directions = operator.direction.directions ?? [];
  const activeDirectionId = state.selectedDirectionId ?? operator.direction.selected_direction_id;
  const editingDirection = directions.find((direction) => state.editing === `direction:${direction.direction_id}`);
  if (editingDirection) {
    return `<div class="center-selection v06-center-selection"><p class="choice-title">글의 방향 수정</p><div class="v06-direction-editor"><label>이 글이 답할 질문<input name="core_question" value="${esc(editingDirection.core_question)}" /></label><label>핵심 주장<textarea name="thesis">${esc(editingDirection.thesis)}</textarea></label><label>독자가 얻는 것<textarea name="reader_value">${esc(editingDirection.reader_value)}</textarea></label><div class="v06-inline-actions"><button type="button" class="v06-action-button primary" data-v06-save-direction="${esc(editingDirection.direction_id)}">변경사항 저장</button><button type="button" class="v06-action-button secondary" data-v06-cancel-edit>취소</button></div></div></div>`;
  }
  const options = directions.map((direction, index) => {
    const label = archetypeLabel(direction.article_archetype);
    return `<button type="button" class="center-option center-option-reveal v06-conversation-option ${activeDirectionId === direction.direction_id ? "selected" : ""}" title="${esc(direction.core_question)}" aria-label="${esc(label)}: ${esc(direction.core_question)}" data-v06-direction="${esc(direction.direction_id)}"><b>${index + 1}</b><span>${esc(label)}</span></button>`;
  }).join("") || `<div class="center-empty">${V06_OPERATOR_COPY.empty}</div>`;
  return `<div class="center-selection v06-center-selection"><p class="choice-title">이 자료로 어떤 글을 쓸까요?</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${options}</div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div></div>`;
}

function renderConversationArgument(operator, state) {
  const claims = operator.argument.claims ?? [];
  const editingClaim = claims.find((claim) => state.editing === `claim:${claim.claim_id}`);
  if (editingClaim) return `<div class="center-selection v06-center-selection"><p class="choice-title">논증 구성 수정</p><div class="v06-direction-editor"><label>주장<textarea data-v06-claim-text="${esc(editingClaim.claim_id)}">${esc(editingClaim.text)}</textarea></label><div class="v06-inline-actions"><button type="button" class="v06-action-button primary" data-v06-save-claim="${esc(editingClaim.claim_id)}">변경사항 저장</button><button type="button" class="v06-action-button secondary" data-v06-cancel-edit>취소</button></div></div></div>`;
  const options = claims.map((claim, index) => `<button type="button" class="center-option center-option-reveal v06-conversation-option ${state.selectedClaimId === claim.claim_id ? "selected" : ""}" title="${esc(claim.text)}" aria-label="${esc(roleLabel(claim.role))}: ${esc(claim.text)}" data-v06-claim="${esc(claim.claim_id)}"><b>${index + 1}</b><span>${esc(`주장 ${index + 1} · ${roleLabel(claim.role)}`)}</span></button>`).join("") || `<div class="center-empty">${V06_OPERATOR_COPY.empty}</div>`;
  return `<div class="center-selection v06-center-selection"><p class="choice-title">논증의 흐름</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${options}</div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div></div>`;
}

function renderConversationWriting(operator, state) {
  const writing = operator.writing;
  const body = writing.body_markdown ?? "";
  const issues = writing.blocked_issues ?? [];
  if (state.editing === "draft") return `<div class="center-selection v06-center-selection v06-writing-stage"><p class="choice-title">본문 편집</p><textarea class="v06-draft-editor" data-v06-draft-editor>${esc(body)}</textarea><details class="v06-draft-diff" open><summary>저장 전 변경사항</summary><pre data-v06-draft-diff>${esc(draftDiff(body, body))}</pre></details><div class="v06-inline-actions"><button type="button" class="v06-action-button primary" data-v06-save-draft>변경사항 저장</button><button type="button" class="v06-action-button secondary" data-v06-cancel-edit>취소</button></div></div>`;
  const draftId = writing.artifact?.artifact_id ?? "draft";
  return `<div class="center-selection v06-center-selection v06-writing-stage"><p class="choice-title">글 검토</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${issues.length ? `<button type="button" class="center-option center-option-reveal v06-conversation-option" data-v06-detail="issue:${esc(issues[0].issue_id ?? "")}" data-v06-detail-trigger="issue:${esc(issues[0].issue_id ?? "")}"><b>1</b><span>검수 의견 ${issues.length}개 확인</span></button>` : ""}<button type="button" class="center-option center-option-reveal v06-conversation-option" data-v06-detail="draft:${esc(draftId)}" data-v06-detail-trigger="draft:${esc(draftId)}"><b>${issues.length ? "2" : "1"}</b><span>본문 전체 보기</span></button></div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div></div>`;
}

function renderConversationPublish(operator) {
  const artifact = operator.publish.artifact;
  return `<div class="center-selection v06-center-selection"><p class="choice-title">발행 준비</p><div class="center-option-scroll-shell"><div class="center-option-scroll">${artifact ? `<button type="button" class="center-option center-option-reveal v06-conversation-option" aria-label="발행 패키지 자세히 보기" data-v06-detail="publish:${esc(artifact.artifact_id ?? "")}" data-v06-detail-trigger="publish:${esc(artifact.artifact_id ?? "")}"><b>1</b><span>발행 패키지 자세히 보기</span></button>` : `<div class="center-empty">${V06_OPERATOR_COPY.empty}</div>`}</div><div class="center-scrollbar" aria-hidden="true"><span></span></div></div></div>`;
}

function renderConversationStage(operator, state, step, actions = []) {
  return step === "research_review" ? renderConversationResearch(operator, state, actions)
    : step === "synthesis_review" ? renderConversationSynthesis(operator, state)
      : step === "editorial_direction_review" ? renderConversationDirection(operator, state)
        : step === "argument_review" ? renderConversationArgument(operator, state)
          : step === "writing_review" ? renderConversationWriting(operator, state)
            : renderConversationPublish(operator);
}

function renderV06HistoryNotice(operator, state, step) {
  const runtimeStep = resolveV06OperatorStep(operator.runtime_view?.current_user_step);
  if (!runtimeStep || step === runtimeStep) return "";
  const interrupted = operator.runtime_view?.execution_state === "blocked" || operator.runtime_view?.execution_state === "failed";
  return `<div class="v06-history-selection history-selection" role="status">
    <p class="history-selection-note">${interrupted ? "대화가 중단되었습니다. 이 단계부터 다시 진행하려면 아래 버튼을 눌러주세요." : "이전 단계 조회 중입니다. 이 단계부터 다시 진행하려면 아래 버튼을 눌러주세요."}</p>
    <button class="return-step-button" type="button" data-v06-return-to-step>해당 단계로 돌아가기</button>
  </div>`;
}

function renderRail({ operator, state, onStep }) {
  const selectedStep = resolveV06OperatorStep(state.selectedStep ?? operator.runtime_view.current_user_step);
  const runtimeStep = resolveV06OperatorStep(operator.runtime_view.current_user_step);
  const browsingPrevious = selectedStep !== runtimeStep;
  return `<div class="rail-section v06-operator-rail">
    <div class="rail-head"><p class="eyebrow">콘텐츠 흐름</p></div>
    <div class="step-list">${operator.steps.map((step, index) => {
      const approved = step.status_code === "approved";
      const progress = !approved && step.current;
      const stateClass = approved ? "done" : progress ? "progress" : "";
      const marker = approved ? "✓" : index + 1;
      const classes = ["step-row", stateClass, step.id === selectedStep ? "selected" : "", step.enabled ? "" : "pending"].filter(Boolean).join(" ");
      const status = approved ? "완료" : progress ? "진행 중" : (["blocked", "failed", "stale"].includes(step.status_code) ? "검토 필요" : "대기");
      return `<button type="button" class="${classes}" data-v06-step="${esc(step.id)}" ${step.enabled ? "" : "disabled"}>
      <span>${marker}</span><p>${esc(step.label)}</p><small>${status}</small>
    </button>`;
    }).join("")}</div>
  </div>
  <div class="state-card v06-state-card"><p class="eyebrow">현재 상태</p><ul>
    <li><span>${browsingPrevious ? "보고 있는 단계" : "진행 단계"}</span><b>${esc(stageLabel(selectedStep)) || "자동 실행 대기"}</b></li>
    ${browsingPrevious ? `<li><span>실제 진행 단계</span><b>${esc(stageLabel(runtimeStep))}</b></li>` : ""}
    <li><span>${browsingPrevious ? "실제 상태" : "상태"}</span><b>${esc(stateLabel(operator.runtime_view.execution_state))}</b></li>
  </ul></div>${renderV06FactCard(operator)}
  <button class="debug-button" type="button" data-v06-debug>Debug JSON 보기<span class="debug-chevron">›</span></button>`;
}

function renderV06FactCard(operator) {
  const writing = operator.writing ?? {};
  if (!writing.artifact && !writing.integrity_review && !(writing.blocked_issues ?? []).length) return "";
  const issues = writing.blocked_issues ?? [];
  const passed = writing.integrity_review?.payload?.integrity_status === "pass";
  const label = issues.length ? `검수 의견 ${issues.length}개` : passed ? "검증 필요 항목 없음" : "검수 결과 확인 필요";
  const icon = issues.length ? "warn-icon" : "check-icon";
  const tag = issues.length ? "Check" : "Text";
  return `<div class="fact-card v06-fact-card"><p class="eyebrow">${esc(copyCatalog.workflow.factCheck)}</p><ul class="mini-checks"><li><div><i class="${icon}"></i><p>${esc(label)}</p></div><span class="${issues.length ? "orange-tag" : "green-tag"}">${tag}</span></li></ul></div>`;
}

function renderResearch(operator) {
  const entries = operator.research.entries ?? [];
  const directEvidenceCount = entries.filter((entry) => (
    entry.evidence_eligibility === "direct"
    && entry.content_quality !== "title_only"
  )).length;
  const coverage = operator.research.coverage ?? {};
  const uniqueCoverage = Array.isArray(coverage) ? [...new Map(coverage.map((lane) => [lane.lane_id, lane])).values()] : [];
  const planLanes = [...new Map((operator.research.plan?.payload?.lanes ?? []).map((lane) => [lane.lane_id, lane])).values()];
  const minimumSourceCount = Number(operator.research.minimum_source_count ?? operator.research.plan?.payload?.target_source_count?.min ?? 0);
  const executionState = operator.runtime_view?.execution_state;
  const ready = !operator.research.artifact && operator.runtime_view?.next_action === "start_research" && executionState === "ready_to_research";
  const running = executionState === "research_running" || (operator.active_runs ?? []).some((run) => run.task_type === "start_research");
  const failed = executionState === "failed";
  const restricted = Boolean(operator.research.artifact)
    && operator.research.editorial_readiness
    && operator.research.editorial_readiness !== "ready";
  const missingLanes = planLanes.filter((lane) => lane.coverage_status === "missing" || uniqueCoverage.find((item) => item.lane_id === lane.lane_id)?.status === "missing");
  const sufficientLanes = uniqueCoverage.filter((lane) => lane.status === "sufficient");
  const belowMinimum = minimumSourceCount > 0 && entries.length < minimumSourceCount;
  const bootstrapNotice = ready
    ? `<div class="v06-bootstrap-notice"><h2>${esc(V06_OPERATOR_COPY.research.readyTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.readyDescription)}</p></div>`
    : running
      ? `<div class="v06-bootstrap-notice is-running"><h2>${esc(V06_OPERATOR_COPY.research.runningTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.runningDescription)}</p>${(operator.active_runs ?? []).filter((run) => run.task_type === "start_research").map((run) => `<small>현재 작업: ${esc(run.task_type)} · ${esc(run.status)} · 시도 ${esc(run.attempt)}</small>`).join("")}</div>`
      : failed
        ? `<div class="v06-bootstrap-notice is-failed"><h2>${esc(V06_OPERATOR_COPY.research.failedTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.failedDescription)}</p></div>`
        : restricted
          ? `<div class="v06-bootstrap-notice is-restricted"><h2>${esc(V06_OPERATOR_COPY.research.readinessTitle)}</h2><p>${esc(V06_OPERATOR_COPY.research.readinessDescription)}</p><strong>현재 자료 수: ${entries.length} / 최소 ${minimumSourceCount || "확인 필요"}</strong><p>충분한 관점: ${esc(sufficientLanes.map((lane) => laneLabel(lane.lane_id)).join(", ") || "아직 없음")}</p><p>핵심 질문에 필요한 관점: ${esc((operator.research.required_lane_ids ?? []).map((lane) => laneLabel(lane)).join(", ") || "확인 필요")}</p><p>부족한 관점: ${esc(missingLanes.map((lane) => lane.label ?? laneLabel(lane.lane_id)).join(", ") || "추가 확인 필요")}</p><ul>${(operator.research.readiness_reasons ?? []).slice(0, 4).map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul><div class="v06-claim-readiness"><p>현재 자료로 확인할 수 있는 주장</p><ul>${Object.entries(operator.research.claim_assessments ?? {}).map(([key, assessment]) => `<li><strong>${esc(key)}</strong> ${esc(claimSupportLabel(assessment.status))}</li>`).join("")}</ul></div><p>${esc(V06_OPERATOR_COPY.research.restrictedContinueWarning)}</p></div>`
          : "";
  return `<section class="v06-stage-content">${bootstrapNotice}<div class="v06-summary-strip"><div><strong>${entries.length}</strong><span>수집한 자료</span></div><div><strong>${directEvidenceCount}</strong><span>직접 근거 자료</span></div><div><strong>${esc(coverageLabel(operator.research.coverage_status))}</strong><span>조사 상태</span></div></div>
    <div class="v06-section-heading"><h2>자료에서 무엇을 확인했나요?</h2><p>자료의 종류와 근거로 사용할 수 있는 범위를 먼저 살펴봅니다.</p></div>
    <div class="v06-source-list">${entries.map((entry) => `<article class="v06-source-row"><div><h3>${esc(entry.title ?? entry.source_ref)}</h3><p>${esc(entry.publisher ?? sourceKindLabel(entry.source_kind))}</p><small>${esc(publisherTypeLabel(entry.publisher_type))} · ${esc(authorityLabel(entry.source_authority))}</small><small>${esc(evidenceLabel(entry.evidence_eligibility ?? entry.usage_policy ?? entry.source_role))} · ${esc(qualityLabel(entry.content_quality))}</small></div><span class="v06-source-quality">${esc(evidenceLabel(entry.evidence_eligibility ?? entry.usage_policy ?? entry.source_role))}</span></article>`).join("") || `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</div>
    <div class="v06-coverage-note">${uniqueCoverage.map((lane) => `<span>${esc(laneLabel(lane.lane_id))} · ${esc(coverageLabel(lane.status))} · ${esc(`${lane.source_count ?? 0}개 자료`)}</span>`).join("")}</div></section>`;
}

function renderSynthesis(operator, state) {
  const findings = operator.synthesis.findings ?? [];
  return `<section class="v06-stage-content"><div class="v06-section-heading"><h2>자료에서 발견한 변화</h2><p>자료를 나열하지 않고, 반복·차이·연결을 비교합니다.</p></div><div class="v06-finding-list">${findings.map((finding) => `<button type="button" class="v06-finding-row ${state.selectedFindingId === finding.finding_id ? "selected" : ""}" data-v06-finding="${esc(finding.finding_id)}"><span>${esc(finding.type_label)}</span><strong>${esc(finding.text)}</strong><small>${(finding.source_refs ?? []).length}개 자료 · ${(finding.basis_refs ?? []).length}개 근거</small>${(finding.limitations ?? []).length ? `<em>한계: ${esc(finding.limitations.join(" "))}</em>` : ""}</button>`).join("") || `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</div></section>`;
}

function renderDirection(operator, state) {
  const directions = operator.direction.directions ?? [];
  return `<section class="v06-stage-content"><div class="v06-section-heading"><h2>이 자료로 어떤 글을 쓸까요?</h2><p>자료에서 발견한 관계를 바탕으로 방향을 고릅니다.</p></div><div class="v06-direction-list">${directions.map((direction) => {
    const selected = direction.direction_id === operator.direction.selected_direction_id;
    const editing = state.editing === `direction:${direction.direction_id}`;
    return `<article class="v06-direction-card ${selected ? "selected" : ""}"><div class="v06-card-heading"><span>${esc(archetypeLabel(direction.article_archetype))}</span>${selected ? "<strong>선택됨</strong>" : ""}</div>${editing ? `<label>이 글이 답할 질문<input name="core_question" value="${esc(direction.core_question)}" /></label><label>핵심 주장<textarea name="thesis">${esc(direction.thesis)}</textarea></label><label>독자가 얻는 것<textarea name="reader_value">${esc(direction.reader_value)}</textarea></label><div class="v06-inline-actions"><button type="button" class="v06-action-button primary" data-v06-save-direction="${esc(direction.direction_id)}">변경사항 저장</button><button type="button" class="v06-action-button secondary" data-v06-cancel-edit>취소</button></div>` : `<h3>${esc(direction.core_question)}</h3><p>${esc(direction.thesis)}</p><dl><div><dt>독자가 얻는 것</dt><dd>${esc(direction.reader_value)}</dd></div><div><dt>주의할 점</dt><dd>${esc((direction.risks ?? []).join(" · ") || "특별한 위험 없음")}</dd></div></dl><div class="v06-inline-actions">${selected ? `<button type="button" class="v06-action-button secondary" data-v06-edit-direction="${esc(direction.direction_id)}">수정</button>` : ""}</div>`}</article>`;
  }).join("") || `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</div></section>`;
}

function renderArgument(operator, state) {
  const claims = operator.argument.claims ?? [];
  return `<section class="v06-stage-content"><div class="v06-section-heading"><h2>${esc(operator.argument.thesis || "논증의 흐름")}</h2><p>주장이 어떤 순서로 이어지고, 어떤 근거를 사용하는지 확인합니다.</p></div><div class="v06-claim-list">${claims.map((claim, index) => {
    const editing = state.editing === `claim:${claim.claim_id}`;
    return `<article class="v06-claim-card ${state.selectedClaimId === claim.claim_id ? "selected" : ""}"><div class="v06-claim-number">${index + 1}</div><div class="v06-claim-body"><span>${esc(roleLabel(claim.role))}</span>${editing ? `<textarea data-v06-claim-text="${esc(claim.claim_id)}">${esc(claim.text)}</textarea><button type="button" class="v06-action-button primary" data-v06-save-claim="${esc(claim.claim_id)}">변경사항 저장</button>` : `<button type="button" class="v06-claim-select" data-v06-claim="${esc(claim.claim_id)}"><h3>${esc(claim.text)}</h3></button><p>${esc(claim.support_type === "fact" ? "원문에서 직접 확인하는 사실" : "여러 자료를 연결한 해석")}</p><small>${(claim.evidence_refs ?? []).length}개 근거 연결 · ${claim.required ? "필수 주장" : "선택 주장"}</small><button type="button" class="v06-text-button" data-v06-edit-claim="${esc(claim.claim_id)}">주장 수정</button>`}</div></article>`;
  }).join("") || `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</div></section>`;
}

function renderWriting(operator, state) {
  const writing = operator.writing;
  const editing = state.editing === "draft";
  const body = writing.body_markdown ?? "";
  const issues = writing.blocked_issues ?? [];
  return `<section class="v06-stage-content v06-writing-stage"><div class="v06-section-heading"><h2>글을 읽고 고쳐보세요</h2><p>근거와 논지가 본문에서 자연스럽게 이어지는지 확인합니다.</p></div><div class="v06-review-status"><span>${writing.integrity_review?.payload?.integrity_status === "pass" ? "근거 검증 완료" : issues.length ? `근거보다 강한 문장 ${issues.length}개` : "검수 필요"}</span><span>${writing.artifact?.verification_status === "verified" ? "검증 완료" : "수정 후 재검증 필요"}</span></div>${editing ? `<textarea class="v06-draft-editor" data-v06-draft-editor>${esc(body)}</textarea><details class="v06-draft-diff" open><summary>저장 전 변경사항</summary><pre data-v06-draft-diff>${esc(draftDiff(body, body))}</pre></details><div class="v06-inline-actions"><button type="button" class="v06-action-button primary" data-v06-save-draft>변경사항 저장</button><button type="button" class="v06-action-button secondary" data-v06-cancel-edit>취소</button></div>` : `<article class="v06-draft-preview">${highlightedMarkdown(body, issues)}</article><div class="v06-inline-actions"><button type="button" class="v06-action-button secondary" data-v06-edit-draft>수정</button></div>`}</section>`;
}

function renderPublish(operator) {
  const artifact = operator.publish.artifact;
  const payload = artifact?.payload ?? {};
  const title = firstPublishValue(payload, "title", firstPublishValue(payload, "title_candidates", "발행 패키지"));
  return `<section class="v06-stage-content"><div class="v06-section-heading"><h2>발행 전에 마지막으로 확인하세요</h2><p>제목과 요약이 최종 본문과 같은 방향을 가리키는지 확인합니다.</p></div>${artifact ? `<div class="v06-publish-card"><h3>${esc(title)}</h3><p>${esc(payload.one_sentence_summary)}</p><small>${esc(payload.intro_preview)}</small></div>` : `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</section>`;
}

function sourceNoteFor(operator, noteRef) {
  return (operator.writing.evidence_catalog ?? []).find((item) => item.note_ref === noteRef)
    ?? (operator.research.source_notes ?? []).find((item) => item.note_id === noteRef || item.note_ref === noteRef);
}

function sourceNoteForSource(operator, sourceRef) {
  return (operator.research.source_notes ?? []).find((item) => item.source_ref === sourceRef)
    ?? (operator.writing.evidence_catalog ?? []).find((item) => item.source_ref === sourceRef);
}

function sourceNoteSummary(note) {
  if (!note) return "";
  const points = [
    ...(note.main_claims ?? []),
    ...(note.facts ?? []),
    ...(note.frames ?? [])
  ].map((item) => typeof item === "string" ? item : item?.text).filter(Boolean);
  return compactText(points[0] ?? note.text ?? "", 220);
}

function renderResearchSourceList(operator) {
  const entries = operator.research.entries ?? [];
  const cards = entries.map((entry) => {
    const note = sourceNoteForSource(operator, entry.source_ref);
    const summary = sourceNoteSummary(note);
    const evidence = evidenceLabel(entry.evidence_eligibility ?? entry.usage_policy ?? entry.source_role);
    const quality = qualityLabel(entry.content_quality);
    return renderReadOnlySourceCard({
      source_id: entry.source_ref,
      source_kind_ui: "research_source",
      title: entry.title ?? entry.source_ref,
      source_title: entry.title ?? entry.source_ref,
      publisher: entry.publisher ?? sourceKindLabel(entry.source_kind),
      source_published_at: entry.published_at,
      canonical_url: entry.canonical_url,
      excerpt: compactText(summary || V06_OPERATOR_COPY.research.sourceSummaryFallback, 150),
      source_authority: entry.source_authority,
      evidence_eligibility: entry.evidence_eligibility ?? entry.usage_policy ?? entry.source_role,
      content_quality: entry.content_quality,
      read_only_status_label: `${evidence} · ${quality}`,
      source_review_status: entry.review_status
    }, `source:${entry.source_ref}`);
  }).join("");
  return `<div class="source-selection-grid">${cards || `<div class="v06-empty">${V06_OPERATOR_COPY.empty}</div>`}</div>`;
}

function renderResearchApprovalPreview(operator) {
  if (!operator.research.artifact) return "";
  const restricted = operator.research.editorial_readiness && operator.research.editorial_readiness !== "ready";
  if (restricted) {
    const [intro, scope, limitations] = V06_OPERATOR_COPY.research.restrictedApproval.split(/\n\n/u);
    return `<div class="v06-next-step-preview is-restricted"><p class="eyebrow">이 자료로 진행하면</p><p>${esc(intro)}</p><strong>${esc(scope)}</strong><p>${esc(limitations)}</p></div>`;
  }
  return `<div class="v06-next-step-preview"><p class="eyebrow">${esc(V06_OPERATOR_COPY.research.approvalNextTitle)}</p><strong>${esc(V06_OPERATOR_COPY.research.approvalNextStep)}</strong><p>${esc(V06_OPERATOR_COPY.research.approvalNextNormal)}</p></div>`;
}

function sourceContextScopes(source) {
  return [...new Set((source?.contextual_for ?? []).map((value) => laneLabel(value)).filter(Boolean))].slice(0, 4);
}

function renderWritingContext(operator) {
  const writing = operator.writing;
  const body = writing.body_markdown ?? "";
  const displayBody = redactProviderEvidence(body);
  const excerpt = compactDraftMarkdown(displayBody);
  const issues = writing.blocked_issues ?? [];
  const issue = issues[0] ?? null;
  const integrityStatus = writing.integrity_review?.payload?.integrity_status === "pass" ? "근거 검증 완료" : issue ? `근거보다 강한 문장 ${issues.length}개` : "검수 필요";
  const verificationStatus = writing.artifact?.verification_status === "verified" ? "검증 완료" : "수정 후 재검증 필요";
  return `<div class="v06-context-content v06-writing-context"><div class="v06-writing-context-heading"><p class="eyebrow">${esc(V06_OPERATOR_COPY.writing.draftHeading)}</p><div class="v06-review-status"><span>${esc(integrityStatus)}</span><span>${esc(verificationStatus)}</span></div></div>${issue ? `<div class="v06-issue-panel"><p class="eyebrow">검수 의견</p><h3>현재 글에서 다시 확인할 부분이 있습니다.</h3><blockquote>${esc(issueText(issue.draft_excerpt, "본문에 연결된 문제 문장이 기록되지 않았습니다."))}</blockquote><p>${esc(issueText(issue.reason, "근거와 주장 사이의 연결을 다시 확인하세요."))}</p><small>권장 작업: 논증 구성 또는 글 검토</small><div class="v06-issue-action">${detailTrigger("issue", issue.issue_id, "검수 내용 자세히 보기")}</div></div>` : ""}<p class="eyebrow">본문 미리보기</p><article class="v06-draft-preview v06-draft-excerpt">${highlightedMarkdown(excerpt, issues)}</article><div class="v06-modal-links">${detailTrigger("draft", writing.artifact?.artifact_id ?? "draft", "본문 전체 보기")}</div></div>`;
}

function detailTrigger(type, id, label = "자세히 보기") {
  return `<button type="button" class="v06-context-detail-button" data-v06-detail="${esc(type)}:${esc(id)}" data-v06-detail-trigger="${esc(type)}:${esc(id)}">${esc(label)}</button>`;
}

function renderContext(operator, state, step) {
  const finding = step === "synthesis_review"
    ? operator.synthesis.findings.find((item) => item.finding_id === state.selectedFindingId)
    : null;
  const claim = step === "argument_review"
    ? operator.argument.claims.find((item) => item.claim_id === state.selectedClaimId)
    : null;
  const direction = step === "editorial_direction_review"
    ? operator.direction.directions.find((item) => item.direction_id === (state.selectedDirectionId ?? operator.direction.selected_direction_id))
    : null;
  const source = step === "research_review"
    ? operator.research.entries.find((item) => item.source_ref === state.selectedSourceId)
    : null;
  const sourceNote = source ? sourceNoteForSource(operator, source.source_ref) : null;
  const note = sourceNoteFor(operator, state.selectedNoteId);
  const issue = step === "writing_review" ? operator.writing.blocked_issues[0] : null;
  if (step === "research_review") {
    const entries = operator.research.entries ?? [];
    const directEvidenceCount = entries.filter((entry) => entry.evidence_eligibility === "direct" && entry.content_quality !== "title_only").length;
    return `<div class="v06-research-context">${renderResearchApprovalPreview(operator)}<div class="v06-research-context-summary"><strong>${entries.length}</strong><span>수집한 자료</span><strong>${directEvidenceCount}</strong><span>직접 근거 자료</span><span class="v06-research-context-status">${esc(coverageLabel(operator.research.coverage_status))}</span></div>${renderResearchSourceList(operator)}</div>`;
  }
  if (finding) return `<div class="v06-context-content"><p class="eyebrow">선택한 발견</p><h3>${esc(compactText(finding.text, 180))}</h3><p>${(finding.basis_refs ?? []).length}개의 근거가 연결되어 있습니다.</p><div class="v06-context-links">${(finding.basis_refs ?? []).slice(0, 4).map((ref, index) => { const note = sourceNoteFor(operator, ref); return detailTrigger("note", ref, `근거 ${index + 1} · ${compactText(note?.title ?? note?.text ?? ref, 44)}`); }).join("")}</div>${detailTrigger("finding", finding.finding_id)}</div>`;
  if (direction) return `<div class="v06-context-content"><p class="eyebrow">선택한 방향</p><h3>${esc(compactText(direction.core_question, 160))}</h3><p>${esc(compactText(direction.thesis, 180))}</p><div class="v06-context-links">${(direction.finding_refs ?? []).slice(0, 3).map((ref, index) => { const linkedFinding = operator.synthesis.findings.find((item) => item.finding_id === ref); return detailTrigger("finding", ref, `발견 ${index + 1} · ${compactText(linkedFinding?.text ?? ref, 52)}`); }).join("")}</div>${detailTrigger("direction", direction.direction_id)}</div>`;
  if (claim) return `<div class="v06-context-content"><p class="eyebrow">선택한 주장</p><h3>${esc(compactText(claim.text, 180))}</h3><p>${esc(claim.support_type === "fact" ? "원문에서 직접 확인하는 사실" : "여러 자료를 연결한 해석")}</p><div class="v06-context-links">${(claim.evidence_refs ?? []).slice(0, 4).map((ref, index) => { const note = sourceNoteFor(operator, ref); return detailTrigger("note", ref, `근거 ${index + 1} · ${compactText(note?.title ?? note?.text ?? ref, 44)}`); }).join("")}</div>${detailTrigger("claim", claim.claim_id)}</div>`;
  if (source) {
    const summary = sourceNoteSummary(sourceNote);
    const scopes = sourceContextScopes(source);
    return `<div class="v06-context-content"><p class="eyebrow">선택한 자료</p><h3>${esc(compactText(source.title ?? source.source_ref, 180))}</h3><p>${esc(source.publisher ?? sourceKindLabel(source.source_kind))}</p><p>${esc(evidenceLabel(source.evidence_eligibility))} · ${esc(qualityLabel(source.content_quality))}</p><p class="eyebrow">${esc(V06_OPERATOR_COPY.research.sourceSummaryTitle)}</p><blockquote>${esc(summary || V06_OPERATOR_COPY.research.sourceSummaryFallback)}</blockquote>${!summary && scopes.length ? `<p class="eyebrow">${esc(V06_OPERATOR_COPY.research.sourceScopeTitle)}</p><p>${esc(V06_OPERATOR_COPY.research.sourceScopePrefix)}</p><div class="v06-scope-list">${scopes.map((scope) => `<span>${esc(scope)}</span>`).join("")}</div>` : ""}${detailTrigger("source", source.source_ref)}</div>`;
  }
  if (note) return `<div class="v06-context-content"><p class="eyebrow">선택한 근거</p><h3>${esc(compactText(note.title ?? note.note_ref, 180))}</h3><p>${esc(compactText(note.text, 180))}</p><p>${esc(evidenceLabel(note.evidence_eligibility))} · ${esc(qualityLabel(note.content_quality))}</p>${detailTrigger("note", note.note_ref)}</div>`;
  if (step === "synthesis_review") return `<div class="v06-context-content"><p class="eyebrow">발견 정리</p><h3>발견을 선택하면 연결된 자료와 한계를 확인합니다.</h3><p>자료를 나열하지 않고, 반복·차이·연결을 비교합니다.</p></div>`;
  if (step === "editorial_direction_review") return `<div class="v06-context-content"><p class="eyebrow">글의 방향</p><h3>방향을 선택하면 질문과 핵심 주장을 확인합니다.</h3><p>자료에서 발견한 관계를 바탕으로 방향을 고릅니다.</p></div>`;
  if (step === "argument_review") return `<div class="v06-context-content"><p class="eyebrow">논증 구성</p><h3>주장을 선택하면 연결된 근거를 확인합니다.</h3><p>주장이 어떤 순서로 이어지고, 어떤 근거를 사용하는지 확인합니다.</p></div>`;
  if (step === "publish_package_review") {
    const artifact = operator.publish.artifact;
    const payload = artifact?.payload ?? {};
    if (artifact) {
      const title = firstPublishValue(payload, "title", firstPublishValue(payload, "title_candidates", "발행 패키지"));
      const subtitle = firstPublishValue(payload, "subtitle", firstPublishValue(payload, "subtitle_candidates", ""));
      const summary = compactText(payload.one_sentence_summary ?? "", 180);
      const intro = compactText(payload.intro_preview ?? "", 220);
      const draftId = operator.writing.artifact?.artifact_id ?? "draft";
      return `<div class="v06-context-content v06-publish-context"><p class="eyebrow">발행 준비</p><h3>${esc(title)}</h3>${subtitle ? `<p class="v06-publish-subtitle">${esc(subtitle)}</p>` : ""}${summary ? `<p class="eyebrow">한 문장 요약</p><p>${esc(summary)}</p>` : ""}${intro ? `<p class="eyebrow">도입 미리보기</p><blockquote>${esc(intro)}</blockquote>` : ""}<div class="v06-modal-links">${detailTrigger("publish", artifact.artifact_id, "발행 패키지 자세히 보기")}${operator.writing.body_markdown ? detailTrigger("draft", draftId, "최종 본문 보기") : ""}</div></div>`;
    }
    return `<div class="v06-context-content"><p class="eyebrow">발행 준비</p><h3>아직 생성되지 않았습니다.</h3><p>이전 단계 승인 후 생성할 수 있습니다.</p></div>`;
  }
  if (step === "writing_review") return renderWritingContext(operator);
  return `<div class="v06-context-content"><p class="eyebrow">근거와 검수</p><h3>대화에서 결과를 선택하면 근거가 여기에 표시됩니다.</h3><p>긴 내용은 자세히 보기를 눌러 확인할 수 있습니다.</p></div>`;
}

function renderDetailModal(operator, state) {
  const detail = state.detailModal;
  if (!detail) return "";
  const [type, ...idParts] = String(detail).split(":");
  const idValue = idParts.join(":");
  const finding = operator.synthesis.findings.find((item) => item.finding_id === idValue);
  const direction = operator.direction.directions.find((item) => item.direction_id === idValue);
  const claim = operator.argument.claims.find((item) => item.claim_id === idValue);
  const issue = (operator.writing.blocked_issues ?? []).find((item) => item.issue_id === idValue);
  const note = sourceNoteFor(operator, idValue);
  const sourceNote = type === "source" ? sourceNoteForSource(operator, idValue) : null;
  const source = operator.research.entries.find((item) => item.source_ref === idValue);
  let title = "상세 내용";
  let eyebrow = "근거";
  let body = "";
  if (type === "finding" && finding) {
    title = finding.type_label ?? "발견";
    eyebrow = "자료에서 발견한 변화";
    body = `<h3>${esc(finding.text)}</h3><p>${(finding.limitations ?? []).length ? `한계: ${esc(finding.limitations.join(" "))}` : "연결된 자료의 관계를 비교해 만든 발견입니다."}</p><dl class="research-detail-meta"><div><dt>연결된 자료</dt><dd>${(finding.source_refs ?? []).length}개</dd></div><div><dt>근거 단위</dt><dd>${(finding.basis_refs ?? []).length}개</dd></div></dl><div class="v06-modal-links">${(finding.basis_refs ?? []).map((ref, index) => detailTrigger("note", ref, `근거 ${index + 1} 열기`)).join("")}</div>`;
  } else if (type === "direction" && direction) {
    title = "글의 방향";
    eyebrow = archetypeLabel(direction.article_archetype);
    body = `<h3>${esc(direction.core_question)}</h3><p>${esc(direction.thesis)}</p><dl class="research-detail-meta"><div><dt>독자가 얻는 것</dt><dd>${esc(direction.reader_value)}</dd></div><div><dt>주의할 점</dt><dd>${esc((direction.risks ?? []).join(" · ") || "확인 필요")}</dd></div><div><dt>근거 공백</dt><dd>${esc((direction.evidence_gaps ?? []).join(" · ") || "없음")}</dd></div></dl>`;
  } else if (type === "claim" && claim) {
    title = "논증 구성";
    eyebrow = roleLabel(claim.role);
    body = `<h3>${esc(claim.text)}</h3><p>${esc(claim.support_type === "fact" ? "원문에서 직접 확인하는 사실" : "여러 자료를 연결한 해석")}</p><dl class="research-detail-meta"><div><dt>필수 여부</dt><dd>${claim.required ? "필수 주장" : "선택 주장"}</dd></div><div><dt>연결된 근거</dt><dd>${(claim.evidence_refs ?? []).length}개</dd></div></dl><div class="v06-modal-links">${(claim.evidence_refs ?? []).map((ref, index) => detailTrigger("note", ref, `근거 ${index + 1} 열기`)).join("")}</div>`;
  } else if (type === "publish") {
    const artifact = operator.publish.artifact;
    const payload = artifact?.payload ?? {};
    title = "발행 준비";
    eyebrow = "최종 패키지";
    const packageTitle = firstPublishValue(payload, "title", firstPublishValue(payload, "title_candidates", "발행 패키지"));
    const subtitle = firstPublishValue(payload, "subtitle", firstPublishValue(payload, "subtitle_candidates", "확인 필요"));
    const thumbnail = firstPublishValue(payload, "thumbnail_copy", firstPublishValue(payload, "thumbnail_copy_candidates", "확인 필요"));
    body = artifact
      ? `<h3>${esc(packageTitle)}</h3><p>${esc(payload.one_sentence_summary ?? "")}</p><dl class="research-detail-meta"><div><dt>부제</dt><dd>${esc(subtitle)}</dd></div><div><dt>도입 미리보기</dt><dd>${esc(payload.intro_preview ?? "확인 필요")}</dd></div><div><dt>썸네일 문구</dt><dd>${esc(thumbnail)}</dd></div></dl>`
      : `<h3>상세 내용을 확인할 수 없습니다.</h3>`;
  } else if (type === "issue" && issue) {
    title = "검수 의견";
    eyebrow = "글 검토";
    body = `<h3>현재 글에서 다시 확인할 부분이 있습니다.</h3><blockquote>${esc(issueText(issue.draft_excerpt, "본문에 연결된 문제 문장이 기록되지 않았습니다."))}</blockquote><p>${esc(issueText(issue.reason, "근거와 주장 사이의 연결을 다시 확인하세요."))}</p><dl class="research-detail-meta"><div><dt>문제가 생긴 단계</dt><dd>${esc(issueText(issue.origin_layer, "글 검토"))}</dd></div><div><dt>권장 작업</dt><dd>${esc(issueText(issue.recommended_route, "논증 구성 또는 글 검토"))}</dd></div></dl>`;
  } else if (type === "draft") {
    title = "초안 본문";
    eyebrow = "글 검토";
    body = `<article class="v06-draft-modal-preview">${highlightedMarkdown(redactProviderEvidence(operator.writing.body_markdown ?? ""), operator.writing.blocked_issues ?? [])}</article>`;
  } else if ((type === "note" && note) || (type === "source" && source)) {
    const item = note ?? source;
    const hydratedNote = note ?? sourceNote;
    title = item.title ?? item.source_ref ?? item.note_ref ?? "자료";
    eyebrow = "Source Note";
    const summary = sourceNoteSummary(hydratedNote) || item.text || item.publisher || "";
    const scopes = type === "source" ? sourceContextScopes(item) : [];
    const locator = hydratedNote?.locator ?? item.locator;
    body = `<h3>${esc(item.title ?? item.source_ref ?? item.note_ref)}</h3><p>${esc(summary)}</p>${!sourceNote && scopes.length ? `<p>${esc(V06_OPERATOR_COPY.research.sourceScopePrefix)}</p><div class="v06-scope-list">${scopes.map((scope) => `<span>${esc(scope)}</span>`).join("")}</div>` : ""}<dl class="research-detail-meta"><div><dt>근거 수준</dt><dd>${esc(evidenceLabel(hydratedNote?.evidence_eligibility ?? item.evidence_eligibility))}</dd></div><div><dt>자료 상태</dt><dd>${esc(qualityLabel(hydratedNote?.content_quality ?? item.content_quality))}</dd></div><div><dt>Locator</dt><dd>${esc(typeof locator === "string" ? locator : JSON.stringify(locator ?? "확인 필요"))}</dd></div></dl>${item.source_url || item.canonical_url ? `<p><a href="${esc(item.source_url ?? item.canonical_url)}" target="_blank" rel="noreferrer">원문 열기 ↗</a></p>` : ""}`;
  }
  return `<div class="research-detail-modal-backdrop v06-detail-modal" data-v06-detail-modal><section class="research-detail-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="research-detail-head"><div><span class="eyebrow">${esc(eyebrow)}</span><strong>${esc(title)}</strong></div><button type="button" class="research-detail-close" data-v06-close-detail aria-label="상세 내용 닫기">×</button></div><div class="v06-detail-modal-body">${body || `<h3>상세 내용을 확인할 수 없습니다.</h3>`}</div></section></div>`;
}

export function renderV06Operator(context) {
  const { nodes, operator, state } = context;
  const step = resolveV06OperatorStep(state.selectedStep ?? operator.runtime_view.current_user_step);
  const selected = operator.steps.find((item) => item.id === step) ?? operator.steps[0];
  const actions = selected?.available_actions ?? [];
  nodes.left.innerHTML = renderRail({ operator, state });
  nodes.center.setAttribute?.("aria-label", "대화");
  nodes.right.setAttribute?.("aria-label", "근거와 검수");
  const stageActions = step === "research_review" ? actions : [];
  const footerActions = step === "research_review" ? "" : actionButtons(actions, selected?.artifact_id);
  const stageMarkup = renderConversationStage(operator, state, step, stageActions);
  const historyNotice = renderV06HistoryNotice(operator, state, step);
  nodes.center.innerHTML = `<div class="panel-title-row"><h1>Conversation</h1><span class="model-pill">GPT 5.6 Luna</span></div><div class="message-stack v06-message-stack">${renderConversationMessage(operator, state, step)}</div>${stageMarkup}${historyNotice}${footerActions || selected?.capabilities?.can_edit && !state.editing ? `<div class="v06-action-bar">${footerActions}${selected?.capabilities?.can_edit && !state.editing ? `<button type="button" class="v06-action-button secondary" data-v06-edit-current>수정</button>` : ""}</div>` : ""}`;
  nodes.center.classList?.toggle?.("v06-editing", Boolean(state.editing));
  nodes.right.innerHTML = `<div class="v06-context-panel"><div class="right-title-row"><h2>근거와 검수</h2><span class="v06-context-state">${esc(stateLabel(selected?.status_code))}</span></div><div class="right-scroll v06-context-scroll">${renderContext(operator, state, step)}</div>${renderDetailModal(operator, state)}</div>`;

  nodes.left.querySelectorAll("[data-v06-step]").forEach((button) => button.addEventListener("click", () => context.onStep(button.dataset.v06Step)));
  nodes.left.querySelector("[data-v06-debug]")?.addEventListener("click", context.onDebug);
  nodes.center.querySelectorAll("[data-v06-action]").forEach((button) => button.addEventListener("click", () => context.onAction({ action: button.dataset.v06Action, task: button.dataset.v06Task, artifactId: button.dataset.v06ArtifactId || selected?.artifact_id })));
  nodes.center.querySelectorAll("[data-v06-finding]").forEach((button) => button.addEventListener("click", () => context.onFinding(button.dataset.v06Finding)));
  nodes.center.querySelectorAll("[data-v06-direction]").forEach((button) => button.addEventListener("click", () => context.onDirection?.(button.dataset.v06Direction)));
  nodes.center.querySelectorAll("[data-v06-source]").forEach((button) => button.addEventListener("click", () => context.onSource?.(button.dataset.v06Source)));
  nodes.center.querySelectorAll("[data-v06-edit-direction]").forEach((button) => button.addEventListener("click", () => context.onEdit(`direction:${button.dataset.v06EditDirection}`)));
  nodes.center.querySelectorAll("[data-v06-edit-claim]").forEach((button) => button.addEventListener("click", () => context.onEdit(`claim:${button.dataset.v06EditClaim}`)));
  nodes.center.querySelectorAll("[data-v06-claim]").forEach((button) => button.addEventListener("click", () => context.onClaim(button.dataset.v06Claim)));
  nodes.center.querySelectorAll("[data-v06-detail]").forEach((button) => button.addEventListener("click", () => context.onModal?.({ open: true, detail: button.dataset.v06Detail })));
  nodes.center.querySelector("[data-v06-return-to-step]")?.addEventListener("click", () => context.onReturnToStep?.());
  nodes.center.querySelector("[data-v06-edit-draft]")?.addEventListener("click", () => context.onEdit("draft"));
  nodes.center.querySelector("[data-v06-draft-editor]")?.addEventListener("input", (event) => {
    const diff = nodes.center.querySelector("[data-v06-draft-diff]");
    if (diff) diff.textContent = draftDiff(operator.writing.body_markdown ?? "", event.target.value);
  });
  nodes.center.querySelector("[data-v06-edit-current]")?.addEventListener("click", () => context.onEdit(step === "writing_review" ? "draft" : step === "argument_review" ? `claim:${operator.argument.claims[0]?.claim_id ?? ""}` : `direction:${operator.direction.selected_direction_id ?? ""}`));
  nodes.center.querySelector("[data-v06-cancel-edit]")?.addEventListener("click", () => context.onEdit(null));
  nodes.center.querySelector("[data-v06-save-draft]")?.addEventListener("click", () => context.onAction({ action: "revise", artifactId: operator.writing.artifact?.artifact_id, bodyMarkdown: nodes.center.querySelector("[data-v06-draft-editor]")?.value ?? "" }));
  nodes.center.querySelectorAll("[data-v06-save-direction]").forEach((button) => button.addEventListener("click", () => {
    const current = operator.direction.directions.find((item) => item.direction_id === button.dataset.v06SaveDirection);
    const next = { ...current, core_question: nodes.center.querySelector("[name=core_question]")?.value ?? current.core_question, thesis: nodes.center.querySelector("[name=thesis]")?.value ?? current.thesis, reader_value: nodes.center.querySelector("[name=reader_value]")?.value ?? current.reader_value };
    const directions = operator.direction.directions.map((item) => item.direction_id === next.direction_id ? next : item);
    context.onAction({ action: "revise", artifactId: operator.direction.artifact?.artifact_id, payload: { ...operator.direction.artifact.payload, directions } });
  }));
  nodes.center.querySelectorAll("[data-v06-save-claim]").forEach((button) => button.addEventListener("click", () => {
    const claims = operator.argument.claims.map((claim) => claim.claim_id === button.dataset.v06SaveClaim ? { ...claim, text: nodes.center.querySelector(`[data-v06-claim-text="${button.dataset.v06SaveClaim}"]`)?.value ?? claim.text } : claim);
    context.onAction({ action: "revise", artifactId: operator.argument.artifact?.artifact_id, payload: { ...operator.argument.artifact.payload, claims } });
  }));
  nodes.right.querySelectorAll("[data-v06-detail]").forEach((button) => button.addEventListener("click", () => context.onModal?.({ open: true, detail: button.dataset.v06Detail })));
  nodes.right.querySelectorAll(".v06-readonly-source-card[data-v06-detail]").forEach((card) => card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    context.onModal?.({ open: true, detail: card.dataset.v06Detail });
  }));
  nodes.right.querySelector("[data-v06-close-detail]")?.addEventListener("click", () => context.onModal?.({ open: false }));
  nodes.right.querySelector("[data-v06-detail-modal]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) context.onModal?.({ open: false });
  });
}
