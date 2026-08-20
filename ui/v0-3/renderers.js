import { isResearchEvidenceSelectable, isResearchSourceSelectable } from "./state.js";
import { buildSourceSelectionProjection } from "./source-selection-projection.js";
import { supportedComponents } from "./component-registry.js";
import { copyCatalog } from "../copy-catalog.js";

export { supportedComponents } from "./component-registry.js";

export function assertKnownComponent(component) {
  if (!supportedComponents.includes(component)) {
    throw new Error(`Unknown ui.component: ${component}`);
  }
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function chips(values = []) {
  return values.map((value) => `<span class="chip">${esc(value)}</span>`).join("");
}

function optionGrid(viewModel) {
  const options = viewModel.ui.options ?? [];
  return `<div class="option-grid">${options
    .map((option, index) => {
      const selected = index === 0;
      return `<article class="option-card ${selected ? "selected" : ""}">
        <div class="option-card-head">
          <h3>${esc(option.title)}</h3>
          ${selected ? '<span class="recommend-badge">선택됨</span>' : ""}
        </div>
        <p>${esc(option.description ?? option.reason)}</p>
        <div class="chip-row">${chips(option.tags)}</div>
      </article>`;
    })
    .join("")}</div>`;
}

function comparisonTable(viewModel) {
  const sections = viewModel.ui.sections ?? [];
  const sectionMarkup = sections
    .map((section) => {
      const kicker = section.label ?? section.type ?? "";
      const bullets = Array.isArray(section.bullets) && section.bullets.length > 0
        ? `<ul class="comparison-bullets">${section.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join("")}</ul>`
        : "";
      return `<article class="comparison-row">
      <div>${kicker ? `<span class="section-kicker">${esc(kicker)}</span>` : ""}<h3>${esc(section.title)}</h3></div>
      ${section.summary || section.description || section.body ? `<p>${esc(section.summary ?? section.description ?? section.body)}</p>` : ""}
      ${bullets}
    </article>`;
    })
    .join("");
  return `<div class="comparison-list">${sectionMarkup}</div>`;
}

const sourceFilterOptions = {
  topic: [
    ["all", "주제"],
    ["uiux", "UI/UX"],
    ["design_system", "디자인 시스템"],
    ["portfolio", "포트폴리오"]
  ],
  reliability: [
    ["all", "신뢰도"],
    ["high", "높음"],
    ["medium", "보통"],
    ["low", "낮음"]
  ],
  source: [
    ["all", "출처"],
    ["internal", "내부 콘텐츠"],
    ["research", "Research"]
  ],
  status: [
    ["approved", "승인 Evidence"],
    ["pending", "검수 대기"],
    ["all", "전체 상태"],
    ["stale", "오래됨"],
    ["rejected", "제외됨"]
  ],
  sort: [
    ["latest", "최신순"],
    ["relevant", "관련도순"],
    ["reliable", "신뢰도순"]
  ]
};

function safeExternalHref(value) {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? esc(url.href) : "";
  } catch {
    return "";
  }
}

function sourceFilterValue(selection, key) {
  if (key === "status") return selection.status_filter ?? "all";
  return selection.filters?.[key] ?? (key === "sort" ? "latest" : "all");
}

function sourceFilterSelect(selection, key) {
  const value = sourceFilterValue(selection, key);
  const defaultValue = key === "sort" ? "latest" : "all";
  const selectedLabel = sourceFilterOptions[key].find(([optionValue]) => optionValue === value)?.[1] ?? sourceFilterOptions[key][0][1];
  return `<label class="source-filter-pill source-filter-${esc(key)} ${value !== defaultValue ? "is-expanded" : ""}" data-source-filter-value="${esc(value)}" data-source-filter-label="${esc(selectedLabel)}"><span class="sr-only">${esc(key)} 필터</span><select name="${esc(key)}" data-source-filter="${esc(key)}" aria-label="${esc(sourceFilterOptions[key][0][1])}">${sourceFilterOptions[key]
    .map(([optionValue, label]) => `<option value="${esc(optionValue)}" ${value === optionValue ? "selected" : ""}>${esc(label)}</option>`)
    .join("")}</select><span class="source-filter-chevron" aria-hidden="true"></span></label>`;
}

export function resolveResearchCtaQuery(selection = {}) {
  const candidates = [
    selection.discovery_plan?.primary_query,
    selection.explicit_search_query,
    selection.current_source_search_query,
    selection.query,
    selection.selection_query,
    selection.original_user_request,
    selection.free_revise,
    selection.selected_topic_title,
    selection.selected_topic,
    [selection.target_track, selection.target_channel, selection.purpose, selection.content_purpose?.label].filter(Boolean).join(" ")
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (normalized.length >= 2) return normalized;
  }
  return "";
}

function sourceResearchCta(selection) {
  const query = resolveResearchCtaQuery(selection);
  const description = query
    ? `현재 결과에 원하는 자료가 없다면 웹에서 '${query}'와 관련된 아티클을 찾아 Research Registry에 추가할 수 있어요.`
    : "현재 검색어를 바탕으로 웹에서 새로운 Research 자료를 찾아볼 수 있어요.";
  const label = query ? `웹에서 '${query}' 검색하기` : "검색어를 먼저 입력해 주세요";
  return `<aside class="source-research-cta" aria-label="추가 Research 검색"><div class="source-research-cta-copy"><strong>원하는 결과물이 없나요?</strong><p>${esc(description)}</p><small>검색 결과는 검수 후 선택할 수 있습니다.</small></div><button type="button" class="source-research-cta-button" data-source-research-cta data-research-query="${esc(query)}" ${query ? "" : "disabled"}>${esc(label)} <span aria-hidden="true">↗</span></button></aside>`;
}

function sourceSearchText(item, kind) {
  return [
    item.title,
    item.claim,
    item.excerpt,
    item.content_roles,
    item.metadata?.topic,
    item.metadata?.category,
    kind === "document" ? item.source_kind : item.source_title
  ].flat().filter(Boolean).join(" ").toLowerCase();
}

function sourceQueryMatches(item, query, kind) {
  const tokens = String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const text = sourceSearchText(item, kind);
  return tokens.some((token) => text.includes(token));
}

function sourceReliability(item, kind) {
  if (kind === "evidence") {
    if (Number.isFinite(Number(item.confidence))) {
      const confidence = Number(item.confidence);
      return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";
    }
    const snapshotStatus = item.snapshot_fetch_status ?? item.snapshot_status ?? item.fetch_status;
    if (item.evidence_status === "approved" && item.source_review_status === "approved" && snapshotStatus === "succeeded") return "high";
    if (item.evidence_status === "pending" || item.evidence_status === "questionable" || item.evidence_status === "needs_context") return "medium";
    return "low";
  }
  if (kind === "research_source") {
    if (item.trust_level === "official" || item.trust_level === "high") return "high";
    if (item.trust_level === "medium") return "medium";
    return "low";
  }
  if (item.metadata?.quality_gold === true || ["published", "reviewed"].includes(item.review_status)) return "high";
  if (["user_rewrite", "structured"].includes(item.content_maturity)) return "medium";
  return "low";
}

function filteredSourceItems(selection) {
  const filters = {
    topic: sourceFilterValue(selection, "topic"),
    reliability: sourceFilterValue(selection, "reliability"),
    source: sourceFilterValue(selection, "source"),
    status: sourceFilterValue(selection, "status"),
    sort: sourceFilterValue(selection, "sort")
  };
  const items = [
    ...(selection.knowledge_documents ?? []).map((item) => ({ ...item, source_kind_ui: "document", source_id: item.document_id ?? item.id })),
    ...(selection.research_evidence ?? []).map((item) => ({ ...item, source_kind_ui: "evidence", source_id: item.evidence_id ?? item.id })),
    ...(selection.research_sources ?? []).map((item) => ({ ...item, source_kind_ui: "research_source", source_id: item.source_id ?? item.id }))
  ].filter((item) => {
    const kind = item.source_kind_ui;
    const text = sourceSearchText(item, kind);
    const reliability = sourceReliability(item, kind);
    const status = kind === "evidence" ? item.evidence_status : kind === "research_source" ? item.source_review_status : item.review_status;
    const topicMatches = filters.topic === "all" || (filters.topic === "uiux" ? /ui\s*[/·-]?\s*ux|서비스 디자인|사용자 경험/i.test(text) : filters.topic === "design_system" ? /디자인 시스템|design system|토큰|컴포넌트/i.test(text) : /포트폴리오|portfolio|사례|case study/i.test(text));
    const sourceMatches = filters.source === "all" || (filters.source === "internal" && kind === "document") || (filters.source === "research" && ["evidence", "research_source"].includes(kind));
    const statusMatches = !["evidence", "research_source"].includes(kind) || filters.status === "all" || status === filters.status;
    return sourceQueryMatches(item, selection.query, kind)
      && topicMatches
      && sourceMatches
      && (filters.reliability === "all" || reliability === filters.reliability)
      && statusMatches;
  });
  if (filters.sort === "latest") {
    items.sort((left, right) => Date.parse(right.fetched_at ?? right.updated_at ?? right.source_published_at ?? 0) - Date.parse(left.fetched_at ?? left.updated_at ?? left.source_published_at ?? 0));
  } else if (filters.sort === "reliable") {
    const rank = { high: 0, medium: 1, low: 2 };
    items.sort((left, right) => rank[sourceReliability(left, left.source_kind_ui)] - rank[sourceReliability(right, right.source_kind_ui)]);
  }
  return items;
}

function canonicalSourceItems(selection) {
  const candidates = [
    ...(selection.ai_initial_selected_documents ?? []).map((item) => ({ ...item, source_kind_ui: "document", source_id: item.document_id ?? item.id })),
    ...(selection.ai_initial_selected_evidence ?? []).map((item) => ({ ...item, source_kind_ui: "evidence", source_id: item.evidence_id ?? item.id })),
    ...(selection.selected_documents ?? []).map((item) => ({ ...item, source_kind_ui: "document", source_id: item.document_id ?? item.id })),
    ...(selection.selected_evidence ?? []).map((item) => ({ ...item, source_kind_ui: "evidence", source_id: item.evidence_id ?? item.id })),
    ...(selection.knowledge_documents ?? []).map((item) => ({ ...item, source_kind_ui: "document", source_id: item.document_id ?? item.id })),
    ...(selection.research_evidence ?? []).map((item) => ({ ...item, source_kind_ui: "evidence", source_id: item.evidence_id ?? item.id }))
  ];
  const byId = new Map();
  for (const item of candidates) {
    if (item.source_id && !byId.has(item.source_id)) byId.set(item.source_id, item);
  }
  return byId;
}

function sourceMeta(item) {
  const dateValue = item.source_published_at ?? item.fetched_at ?? item.updated_at;
  const date = dateValue ? String(dateValue).slice(0, 10).replaceAll("-", ".") : "";
  if (item.source_kind_ui === "evidence") {
    return [item.publisher ?? item.source_title ?? "외부 Source", date].filter(Boolean).join(" · ");
  }
  if (item.source_kind_ui === "research_source") {
    return [item.publisher ?? item.domain ?? "Research Source", date].filter(Boolean).join(" · ");
  }
  return [item.source_title ?? item.source_kind ?? item.target_channel ?? "내부 콘텐츠", date].filter(Boolean).join(" · ");
}

function sourceTypeMeta(item) {
  if (item.source_kind_ui === "evidence") {
    const sourceType = String(item.source_type ?? item.source_kind ?? "").toLowerCase();
    const label = /blog|article|news|post/.test(sourceType) ? "블로그" : "외부 논문";
    return { label, className: label === "블로그" ? "blog" : "external" };
  }
  if (item.source_kind_ui === "research_source") return { label: "Research Source", className: "external" };
  const sourceKind = String(item.source_kind ?? "").toLowerCase();
  if (sourceKind === "inblog_article" || sourceKind === "blog") return { label: "블로그", className: "blog" };
  return { label: "내부 콘텐츠", className: "internal" };
}

function sourceReliabilityLabel(item) {
  return { high: "높음", medium: "보통", low: "낮음" }[sourceReliability(item, item.source_kind_ui)] ?? "보통";
}

function sourceCard(item, selected, discoveryReason = null, { readOnly = false, detailId = "" } = {}) {
  const isEvidence = item.source_kind_ui === "evidence";
  const isResearchSource = item.source_kind_ui === "research_source";
  const selectable = isResearchSource
    ? isResearchSourceSelectable(item)
    : !isEvidence || isResearchEvidenceSelectable(item);
  const title = item.title ?? item.claim ?? item.source_title ?? item.source_id;
  const selectLabel = `${title} ${copyCatalog.sourceSelection.select}`;
  const excerpt = item.excerpt ?? (isResearchSource ? "원문 Snapshot과 Evidence가 아직 연결되지 않은 Research 원본입니다." : "");
  const sourceType = sourceTypeMeta(item);
  const cardClass = readOnly
    ? ["source-selection-card", "v06-readonly-source-card", selected ? "selected" : "", selectable ? "" : "is-disabled"].filter(Boolean).join(" ")
    : `source-selection-card ${selected ? "selected" : ""} ${selectable ? "" : "is-disabled"}`;
  const statusLabel = readOnly && item.read_only_status_label
    ? item.read_only_status_label
    : isResearchSource
    ? (selectable ? "선택 후 원문 자동 확보" : (item.source_review_status === "pending" ? "검수 대기" : item.source_review_status ?? "선택 불가"))
    : isEvidence && !selectable ? (item.evidence_status === "pending" ? "검수 대기" : "선택 불가") : "";
  const detail = readOnly
    ? ""
    : discoveryReason
    ? `<button type="button" class="source-card-detail source-card-replace" data-source-replace="${esc(item.source_id)}" data-source-replace-kind="${esc(isEvidence ? "evidence" : isResearchSource ? "research_source" : "document")}">교체</button>`
    : isEvidence
    ? `<button type="button" class="source-card-detail" data-research-detail="${esc(item.source_id)}">상세 ↗</button>`
    : isResearchSource
      ? `<button type="button" class="source-card-detail" data-research-source-detail="${esc(item.source_id)}">상세 ↗</button>`
    : `<button type="button" class="source-card-detail" data-source-detail-document="${esc(item.source_id)}">상세 ↗</button>`;
  const readOnlyAttributes = readOnly
    ? ` data-v06-detail="${esc(detailId)}" data-v06-detail-trigger="${esc(detailId)}" role="button" tabindex="0" aria-label="${esc(title)} ${copyCatalog.sourceSelection.openDetail}"`
    : "";
  const detailWrap = readOnly ? "" : `<div class="source-card-detail-wrap">${detail}</div>`;
  return `<article class="${cardClass}" data-source-id="${esc(item.source_id)}" data-source-kind="${esc(item.source_kind_ui)}" aria-disabled="${selectable ? "false" : "true"}"${readOnlyAttributes}>
    ${readOnly ? "" : `<label class="source-card-check" aria-label="${esc(selectLabel)}">
      <input class="source-card-input" type="checkbox" ${selected ? "checked" : ""} ${selectable ? "" : "disabled"} />
      <span class="source-card-checkmark" aria-hidden="true"></span>
    </label>`}
    <div class="source-card-content">
      <div class="source-card-topline"><span class="source-type-badge ${sourceType.className}">${sourceType.label}</span><span class="source-card-separator" aria-hidden="true">|</span><span class="source-reliability">신뢰도: ${sourceReliabilityLabel(item)}</span>${statusLabel ? `<span class="source-card-status">${statusLabel}</span>` : ""}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(excerpt)}</p>
      <small><span>출처</span><b aria-hidden="true">|</b>${esc(sourceMeta(item))}</small>
    </div>
    ${detailWrap}
  </article>`;
}

export function renderReadOnlySourceCard(item, detailId) {
  return sourceCard(item, false, null, { readOnly: true, detailId });
}

function evidenceStatusValue(detail) {
  const value = String(detail?.evidence?.status ?? detail?.evidence?.evidence_status ?? "pending");
  return ["pending", "approved", "questionable", "stale", "rejected"].includes(value) ? value : "pending";
}

function evidenceConfidenceValue(detail) {
  const value = Number(detail?.evidence?.confidence);
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  return [0.3, 0.6, 0.9].includes(rounded) ? String(rounded) : "";
}

function evidenceStatusChoices(currentStatus) {
  return [
    ["pending", "Pending", "pending"],
    ["approved", "승인", "approved"],
    ["questionable", "확인 필요", "questionable"],
    ["stale", "오래됨", "stale"],
    ["rejected", "제외", "rejected"]
  ].map(([value, label, tone]) => `<button type="button" class="research-status-choice research-status-choice-${tone} ${currentStatus === value ? "is-selected" : ""}" data-research-evidence-status-choice="${value}" aria-pressed="${currentStatus === value ? "true" : "false"}">${label}</button>`).join("");
}

function evidenceConfidenceChoices(currentConfidence) {
  return [
    ["", "미설정", "unset"],
    ["0.9", "높음 · 90%", "high"],
    ["0.6", "보통 · 60%", "medium"],
    ["0.3", "낮음 · 30%", "low"]
  ].map(([value, label, tone]) => `<button type="button" class="research-confidence-choice research-confidence-choice-${tone} ${currentConfidence === value ? "is-selected" : ""}" data-research-evidence-confidence-choice="${value}" aria-pressed="${currentConfidence === value ? "true" : "false"}">${label}</button>`).join("");
}

function sourceReliabilityChoices(currentReliability) {
  return [
    ["high", "높음", "high"],
    ["medium", "보통", "medium"],
    ["low", "낮음", "low"]
  ].map(([value, label, tone]) => `<button type="button" class="research-confidence-choice research-confidence-choice-${tone} ${currentReliability === value ? "is-selected" : ""}" data-research-source-reliability-choice="${value}" aria-pressed="${currentReliability === value ? "true" : "false"}">${label}</button>`).join("");
}

function sourceSelection(viewModel) {
  const selection = viewModel.ui.source_selection ?? {};
  const projection = buildSourceSelectionProjection(selection);
  const selectedIds = new Set([
    ...projection.effective_selected.document_ids,
    ...projection.effective_selected.evidence_ids
  ]);
  const autoSelected = projection.counts.ai_initial > 0;
  const discoveryReasons = selection.ai_selection_reasons ?? selection.discovery_plan?.selection_reasons ?? {};
  const detail = selection.research_detail;
  const detailEvidenceId = detail?.evidence?.evidence_id ?? detail?.evidence?.id ?? "";
  const detailHref = safeExternalHref(detail?.source?.canonical_url);
  const currentEvidenceStatus = evidenceStatusValue(detail);
  const currentEvidenceConfidence = evidenceConfidenceValue(detail);
  const detailSourceLink = detailHref ? `<a class="research-detail-head-source-link" href="${detailHref}" target="_blank" rel="noreferrer">원문 열기 ↗</a>` : "";
  const detailMarkup = detail ? `<div class="research-detail-modal-backdrop" data-research-detail-modal><section class="research-detail-modal" role="dialog" aria-modal="true" aria-labelledby="research-detail-title"><div class="research-detail-head"><div class="research-detail-head-source">${detailSourceLink}</div><div class="research-detail-head-actions"><button type="button" class="research-detail-cancel" data-research-detail-cancel>취소</button><button type="button" class="research-detail-save" data-research-evidence-save data-research-evidence-id="${esc(detailEvidenceId)}">저장</button></div></div><h3 id="research-detail-title">${esc(detail.evidence?.claim ?? "")}</h3><p>${esc(detail.evidence?.excerpt ?? "")}</p><dl class="research-detail-meta"><div><dt>상태</dt><dd><div class="research-detail-value-pills" role="group" aria-label="Evidence 상태">${evidenceStatusChoices(currentEvidenceStatus)}</div></dd></div><div><dt>신뢰도</dt><dd><div class="research-detail-value-pills" role="group" aria-label="Evidence 신뢰도">${evidenceConfidenceChoices(currentEvidenceConfidence)}</div></dd></div><div><dt>Source</dt><dd title="${esc(detail.source?.metadata?.title ?? detail.source?.canonical_url ?? "-")}">${esc(detail.source?.metadata?.title ?? detail.source?.canonical_url ?? "-")}</dd></div><div><dt>Publisher</dt><dd title="${esc(detail.source?.publisher ?? "-")}">${esc(detail.source?.publisher ?? "-")}</dd></div><div><dt>Snapshot</dt><dd title="${esc(detail.snapshot?.id ?? "-")}">${esc(detail.snapshot?.id ?? "-")} · ${esc(detail.snapshot?.fetch_status ?? "-")}</dd></div><div><dt>Locator</dt><dd title="${esc(detail.evidence?.locator?.heading ?? detail.evidence?.locator?.paragraph ?? "-")}">${esc(detail.evidence?.locator?.heading ?? detail.evidence?.locator?.paragraph ?? "-")}</dd></div><div><dt>Fetched</dt><dd title="${esc(detail.snapshot?.fetched_at ?? detail.evidence?.fetched_at ?? "-")}">${esc(detail.snapshot?.fetched_at ?? detail.evidence?.fetched_at ?? "-")}</dd></div><div><dt>Valid until</dt><dd title="${esc(detail.evidence?.valid_until ?? "제한 없음")}">${esc(detail.evidence?.valid_until ?? "제한 없음")}</dd></div></dl><details><summary>provenance 보기</summary><code>${esc(JSON.stringify(detail.provenance ?? {}, null, 2))}</code></details></section></div>` : "";
  const documentDetail = selection.source_document_detail;
  const sourceDetail = selection.research_source_detail;
  const sourceDetailId = sourceDetail?.source_id ?? sourceDetail?.id ?? "";
  const sourceDetailHref = safeExternalHref(sourceDetail?.canonical_url);
  const sourceTrust = sourceDetail?.trust_level === "high" || sourceDetail?.trust_level === "official" ? "high" : sourceDetail?.trust_level === "medium" ? "medium" : "low";
  const sourceStatus = evidenceStatusValue({ evidence: { status: sourceDetail?.source_review_status } });
  const sourceTrustValue = sourceTrust === "official" ? "high" : sourceTrust;
  const sourceDetailSourceLink = sourceDetailHref ? `<a class="research-detail-head-source-link" href="${sourceDetailHref}" target="_blank" rel="noreferrer">원문 열기 ↗</a>` : "";
  const sourceDetailMarkup = sourceDetail ? `<div class="research-detail-modal-backdrop" data-research-detail-modal><section class="research-detail-modal" role="dialog" aria-modal="true" aria-labelledby="source-detail-title"><div class="research-detail-head"><div class="research-detail-head-source"><span class="eyebrow">Research Registry</span><strong>Research Source 상세</strong>${sourceDetailSourceLink}</div><div class="research-detail-head-actions"><button type="button" class="research-detail-cancel" data-research-source-cancel>취소</button><button type="button" class="research-detail-save" data-research-source-save data-research-source-id="${esc(sourceDetailId)}">저장</button></div></div><h3 id="source-detail-title">${esc(sourceDetail.source_title ?? sourceDetail.publisher ?? sourceDetail.canonical_url ?? "")}</h3><p>${esc(sourceDetail.metadata?.description ?? "Snapshot과 Evidence 연결 상태를 확인하고 원문 검수를 진행할 수 있습니다.")}</p><dl class="research-detail-meta"><div><dt>Source ID</dt><dd title="${esc(sourceDetailId)}">${esc(sourceDetailId)}</dd></div><div><dt>Publisher</dt><dd title="${esc(sourceDetail.publisher ?? "-")}">${esc(sourceDetail.publisher ?? "-")}</dd></div><div><dt>Review status</dt><dd><div class="research-detail-value-pills" role="group" aria-label="Research Source 검수 상태">${evidenceStatusChoices(sourceStatus)}</div></dd></div><div><dt>Trust level</dt><dd><div class="research-detail-value-pills" role="group" aria-label="Research Source 신뢰도">${sourceReliabilityChoices(sourceTrustValue)}</div></dd></div><div><dt>Snapshot</dt><dd title="${esc(sourceDetail.snapshot_status ?? "not_fetched")}">${esc(sourceDetail.snapshot_status ?? "not_fetched")}</dd></div><div><dt>Evidence</dt><dd title="${esc(sourceDetail.evidence_status ?? "not_extracted")}">${esc(sourceDetail.evidence_status ?? "not_extracted")}</dd></div><div><dt>Canonical URL</dt><dd title="${esc(sourceDetail.canonical_url ?? "-")}">${esc(sourceDetail.canonical_url ?? "-")}</dd></div></dl><details><summary>metadata 보기</summary><code>${esc(JSON.stringify(sourceDetail.metadata ?? {}, null, 2))}</code></details></section></div>` : "";
  const documentDetailMarkup = documentDetail ? `<div class="research-detail-modal-backdrop" data-research-detail-modal><section class="research-detail-modal" role="dialog" aria-modal="true" aria-labelledby="document-detail-title"><div class="research-detail-head"><div><span class="eyebrow">Knowledge</span><strong>내부 콘텐츠 상세</strong></div><button type="button" class="research-detail-close" data-research-detail-close aria-label="상세 자료 닫기">×</button></div><h3 id="document-detail-title">${esc(documentDetail.title ?? "")}</h3><p>${esc(documentDetail.excerpt ?? "")}</p><dl class="research-detail-meta"><div><dt>Source kind</dt><dd>${esc(documentDetail.source_kind ?? "-")}</dd></div><div><dt>Target channel</dt><dd>${esc(documentDetail.target_channel ?? "-")}</dd></div><div><dt>Maturity</dt><dd>${esc(documentDetail.content_maturity ?? "-")}</dd></div><div><dt>Review status</dt><dd>${esc(documentDetail.review_status ?? "-")}</dd></div></dl><div class="research-detail-actions"><button type="button" data-research-detail-close>닫기</button></div></section></div>` : "";
  const items = filteredSourceItems(selection);
  const pendingItems = (selection.research_pending_results ?? [])
    .map((item) => ({ ...item, source_kind_ui: "evidence", source_id: item.evidence_id ?? item.id }))
    .filter((item) => item.evidence_status === "pending");
  const searchState = selection.search_state ?? (items.length ? "results_ready" : "empty");
  const emptyText = selection.error_message ?? (selection.query ? "다른 검색어나 필터를 사용해 보세요." : "검색어를 입력하거나 목적에 맞는 자료를 찾아보세요.");
  const visibleResultLimit = Math.max(Number(selection.visible_result_limit) || 10, 10);
  const visibleItems = items.slice(0, visibleResultLimit);
  const sourceItemsById = canonicalSourceItems(selection);
  const discoverySourceIds = [
    ...projection.ai_initial.document_ids,
    ...projection.ai_initial.evidence_ids
  ];
  const discoveryItems = discoverySourceIds.map((id) => sourceItemsById.get(id)).filter(Boolean);
  const selectedItems = [
    ...projection.effective_selected.document_ids,
    ...projection.effective_selected.evidence_ids
  ].map((id) => sourceItemsById.get(id)).filter(Boolean);
  const aiInitialIds = new Set(discoverySourceIds);
  const cards = visibleItems.map((item) => sourceCard(item, selectedIds.has(item.source_id))).join("");
  const selectedCards = discoveryItems.map((item) => sourceCard(item, selectedIds.has(item.source_id), discoveryReasons[item.source_id] ?? null)).join("");
  const effectiveSelectedCards = selectedItems.map((item) => sourceCard(item, true)).join("");
  const pendingCards = pendingItems.slice(0, visibleResultLimit).map((item) => sourceCard(item, selectedIds.has(item.source_id))).join("");
  const loadMoreMarkup = items.length > visibleItems.length
    ? `<div class="source-load-more-wrap"><button type="button" class="source-load-more" data-source-load-more>더 로드하기 <span>${visibleItems.length}/${items.length}</span></button></div>`
    : "";
  const pendingLoadMoreMarkup = pendingItems.length > visibleResultLimit
    ? `<div class="source-load-more-wrap"><button type="button" class="source-load-more" data-source-load-more>검수 대기 더 보기 <span>${Math.min(visibleResultLimit, pendingItems.length)}/${pendingItems.length}</span></button></div>`
    : "";
  const pendingMarkup = selection.status_filter === "approved" && pendingCards
    ? `<section class="source-pending-results" data-source-pending-results><h3>이번 검색 검수 대기</h3><div class="source-selection-grid">${pendingCards}</div>${pendingLoadMoreMarkup}</section>`
    : "";
  const retryMarkup = selection.research_request?.retryable && selection.research_request?.job_id
    ? `<button type="button" data-source-research-retry data-research-job-id="${esc(selection.research_request.job_id)}">Research 다시 시도</button>`
    : "";
  const query = selection.query ?? "";
  const controlsMarkup = `<form class="source-selection-controls" data-source-search-form>
      <div class="source-search-row ${query ? "has-query" : ""}"><div class="source-search-input"><img src="/assets/figma-magnifying-glass.svg" width="16" height="16" alt="" /><input name="query" value="${esc(query)}" placeholder="검색어를 입력하세요" aria-label="자료 검색" /></div><button class="source-search-clear" type="button" data-source-search-clear aria-label="검색어 지우기">검색어 지우기</button><button type="submit" class="source-search-submit" ${query ? "" : "disabled"}>검색</button></div>
      <div class="source-filter-row">${sourceFilterSelect(selection, "topic")}${sourceFilterSelect(selection, "reliability")}${sourceFilterSelect(selection, "source")}${sourceFilterSelect(selection, "status")}${sourceFilterSelect(selection, "sort")}</div>
    </form>`;
  const selectionBreakdown = `AI 최초 추천 ${projection.counts.ai_initial}개 · 사용자 추가 ${projection.counts.user_added}개 · AI 추천에서 제외 ${projection.counts.user_removed}개`;
  const saveStatus = selection.selection_save_status === "saving"
    ? "변경사항 저장 중…"
    : selection.selection_save_status === "error"
      ? "저장 실패 · 다시 시도"
      : selection.selection_save_status === "saved"
        ? "저장됨"
        : "";
  const resultHeadMarkup = `<div class="source-selection-results-head"><span>전체 검색 결과 <strong>${items.length}개</strong><button type="button" class="source-search-reset-all" data-source-search-reset-all>초기화</button></span><div class="source-selection-results-actions"><strong>최종 선택 ${projection.counts.effective}개</strong><span class="source-selection-selection-breakdown" title="${esc(selectionBreakdown)}" aria-label="선택 구성: ${esc(selectionBreakdown)}">선택 구성</span>${saveStatus ? `<span class="source-selection-save-status source-selection-save-status-${selection.selection_save_status}" data-source-save-status>${esc(saveStatus)}</span>` : ""}<span aria-hidden="true">|</span><button type="button" data-source-clear-selection ${selectedIds.size ? "" : "disabled"}>선택 해제</button></div></div>`;
  const resultListMarkup = `${searchState === "searching" ? `<div class="source-empty source-empty-loading" aria-live="polite"><span class="source-loading-dot"></span><strong>자료를 찾고 있습니다</strong><p>Knowledge와 Research Registry를 함께 검색합니다.</p></div>` : searchState === "error" ? `<div class="source-empty source-empty-error" role="alert"><strong>자료 검색을 완료하지 못했습니다.</strong><p>${esc(emptyText)}</p>${retryMarkup}</div>` : cards ? `<div class="source-selection-grid" data-source-results>${cards}</div>${loadMoreMarkup}` : `<div class="source-empty" data-source-empty><span class="source-empty-icon" aria-hidden="true"><img src="/assets/figma-magnifying-glass.svg" width="16" height="16" alt="" /></span><strong>검색 결과가 없습니다</strong><p>${esc(emptyText)}</p><button type="button" data-source-search-reset>검색어 초기화</button></div>`}
    ${pendingMarkup}
    ${sourceResearchCta(selection)}`;
  const recommendedMarkup = autoSelected
    ? `<details class="source-selection-recommended"><summary><div><strong id="source-selection-recommended-title">AI 최초 추천 자료 ${projection.counts.ai_initial}개</strong><p>처음 진입할 때 목적과 채널을 기준으로 고정한 추천입니다.</p></div></summary><div class="source-selection-recommended-body"><div class="source-selection-recommended-body-inner">${selectedCards ? `<div class="source-selection-grid source-selection-recommended-grid">${selectedCards}</div>` : `<div class="source-empty"><strong>AI 최초 추천 자료가 없습니다</strong></div>`}</div></div></details>`
    : "";
  const selectedMarkup = `<details class="source-selection-selected"><summary><div class="source-selection-section-head"><div><h3>선택한 자료 ${projection.counts.effective}개</h3></div></div></summary><div class="source-selection-selected-body">${effectiveSelectedCards ? `<div class="source-selection-grid">${effectiveSelectedCards}</div>` : `<div class="source-empty"><strong>선택한 자료가 없습니다</strong><p>AI 추천을 복원하거나 검색 결과에서 자료를 추가해 주세요.</p></div>`}</div></details>`;
  return `<div class="source-selection-view" data-source-selection-root>
    <div data-source-selection-modals>${detailMarkup}${documentDetailMarkup}${sourceDetailMarkup}</div>
    <div data-source-search-controls>${controlsMarkup}</div>
    <div data-source-selection-summary>${resultHeadMarkup}</div>
    <div data-source-ai-discovery>${recommendedMarkup}</div>
    <div data-source-search-results>${resultListMarkup}</div>
    <div data-source-selected-list>${selectedMarkup}</div>
  </div>`;
}

function checklist(viewModel) {
  const items = viewModel.ui.checklist ?? viewModel.stateSummary.fact_check_items ?? [];
  return `<ul class="checklist">${items
    .map((item) => `<li><span></span><p>${esc(item.label ?? item.title ?? item)}</p></li>`)
    .join("")}</ul>`;
}

function outlineViewer(viewModel) {
  return `<div class="outline-viewer">${(viewModel.ui.sections ?? [])
    .map((section, index) => `<section>
      <span class="outline-index">${String(index + 1).padStart(2, "0")}</span>
      <h3>${esc(section.title)}</h3>
      ${section.summary || section.description || section.body ? `<p>${esc(section.summary ?? section.description ?? section.body)}</p>` : ""}
      ${Array.isArray(section.bullets) && section.bullets.length > 0 ? `<ul>${section.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join("")}</ul>` : ""}
    </section>`)
    .join("")}</div>`;
}

function inlineMarkdown(value) {
  const links = [];
  const source = String(value ?? "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safeHref = safeExternalHref(href);
    if (!safeHref) return label;
    const token = `__OZ_MARKDOWN_LINK_${links.length}__`;
    links.push({ label: esc(label), href: safeHref });
    return token;
  });
  return esc(source)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/__OZ_MARKDOWN_LINK_(\d+)__/g, (_, index) => {
      const link = links[Number(index)];
      return link ? `<a href="${link.href}" target="_blank" rel="noreferrer">${link.label}</a>` : "";
    });
}

export function markdownToHtml(markdown = "") {
  const lines = String(markdown).split("\n");
  const html = [];
  let listItems = [];
  let listTag = "ul";

  function flushList() {
    if (listItems.length === 0) return;
    html.push(`<${listTag}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${listTag}>`);
    listItems = [];
    listTag = "ul";
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (listTag !== "ul") flushList();
      listTag = "ul";
      listItems.push(bullet[1]);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listTag !== "ol") flushList();
      listTag = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    const quote = line.match(/^>\s+(.+)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    flushList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  flushList();
  return html.join("");
}

export function markdownBlock(markdown) {
  return `<div class="markdown-preview">${markdownToHtml(markdown)}</div>`;
}

function dataAttr(value) {
  return esc(String(value ?? ""));
}

function editableWritingBlock({ title, markdown, sectionId = "body", sourceStep = "" }) {
  return `<section
    class="editable-writing-section"
    data-writing-section-id="${dataAttr(sectionId)}"
    data-writing-source-step="${dataAttr(sourceStep)}"
    data-writing-title="${dataAttr(title)}"
    data-writing-content="${dataAttr(markdown)}"
  >
    <div class="writing-card-head">
      <span>Writing</span>
      <div>
        <button type="button" data-writing-open>편집</button>
      </div>
    </div>
    <h4>${esc(title)}</h4>
    ${markdownBlock(markdown)}
  </section>`;
}

function getSections(viewModel) {
  return Array.isArray(viewModel.ui.sections) ? viewModel.ui.sections : [];
}

function findSection(sections, ids = []) {
  const idSet = new Set(ids);
  return sections.find((section) => idSet.has(section?.id));
}

function bulletToMarkdown(bullet) {
  if (bullet === undefined || bullet === null) return "";
  if (typeof bullet === "string") return bullet;
  if (typeof bullet === "object") {
    return (
      bullet.body_markdown ??
      bullet.markdown ??
      bullet.body ??
      bullet.text ??
      bullet.description ??
      bullet.summary ??
      bullet.title ??
      ""
    );
  }
  return String(bullet);
}

function sectionToMarkdown(section) {
  if (!section) return "";

  const direct =
    section.body_markdown ??
    section.markdown ??
    section.body ??
    section.content ??
    "";

  if (direct) return String(direct);

  const bullets = Array.isArray(section.bullets)
    ? section.bullets.map((bullet) => bulletToMarkdown(bullet)).filter(Boolean)
    : [];

  if (bullets.length > 0) return bullets.join("\n\n");

  return section.summary ?? section.description ?? "";
}

function renderBullets(section) {
  const bullets = Array.isArray(section?.bullets)
    ? section.bullets.map((bullet) => bulletToMarkdown(bullet)).filter(Boolean)
    : [];

  if (bullets.length === 0) return "";
  return `<ul class="package-bullets">${bullets.map((bullet) => `<li>${inlineMarkdown(bullet)}</li>`).join("")}</ul>`;
}

function writingSectionTitle(section, viewModel) {
  if (viewModel?.step === "publish_package_review" && section?.id === "publish_body") {
    return "최종 본문";
  }

  if (viewModel?.step === "draft_review" && section?.id === "draft") {
    return section.title ?? "브런치 초안";
  }

  return section?.title ?? section?.id ?? "본문";
}

function renderPackageUiSection(section, viewModel) {
  if (!section) return "";

  const isBody = ["draft", "publish_body", "body", "draft_body"].includes(section.id);
  const bodyMarkdown = sectionToMarkdown(section);

  if (isBody) {
    return editableWritingBlock({
      title: writingSectionTitle(section, viewModel),
      markdown: bodyMarkdown,
      sectionId: section.id ?? "body",
      sourceStep: viewModel?.step ?? ""
    });
  }

  return `<section class="package-section package-ui-section">
    <h4>${esc(section.title ?? section.id)}</h4>
    ${section.summary ? `<p>${esc(section.summary)}</p>` : ""}
    ${renderBullets(section)}
  </section>`;
}


function draftViewer(viewModel) {
  const sections = getSections(viewModel);
  const draftSection = findSection(sections, ["draft", "draft_body", "publish_body", "body"]);

  const draftMarkdown =
    viewModel.ui.draft?.body_markdown ??
    viewModel.ui.draft?.body ??
    sectionToMarkdown(draftSection);

  const supportSections = sections.filter((section) => section !== draftSection);

  return `<div class="draft-view">
    ${
      draftMarkdown
        ? editableWritingBlock({
            title: draftSection?.title ?? "본문 초안",
            markdown: draftMarkdown,
            sectionId: draftSection?.id ?? "draft",
            sourceStep: viewModel.step
          })
        : `<p class="empty-renderer-note">표시할 초안 본문이 없습니다.</p>`
    }
    ${
      supportSections.length
        ? `<div class="draft-support-sections">${supportSections.map((section) => renderPackageUiSection(section, viewModel)).join("")}</div>`
        : ""
    }
  </div>`;
}

function imagePromptCards(viewModel) {
  return `<div class="prompt-grid">${(viewModel.ui.image_prompts ?? [])
    .map((prompt) => `<article class="prompt-card">
      <h3>${esc(prompt.title ?? prompt.id)}</h3>
      <p>${esc(prompt.prompt ?? prompt.description)}</p>
      <div class="chip-row">${chips(prompt.tags)}</div>
    </article>`)
    .join("")}</div>`;
}

function valueText(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "완료" : "대기";
  return value ?? "";
}

function keyValueList(values = {}) {
  const rows = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (rows.length === 0) return "";
  return `<dl class="package-fields">${rows
    .map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(valueText(value))}</dd></div>`)
    .join("")}</dl>`;
}

function packageReferences(references = []) {
  if (!Array.isArray(references) || references.length === 0) return "";
  return `<section class="package-section">
    <h4>References</h4>
    <div class="package-list">${references
      .map((reference) => `<article>
        <h5>${esc(reference.title ?? reference.id)}</h5>
        ${keyValueList({
          source: reference.source,
          url: reference.url,
          date: reference.published_or_accessed_at,
          summary: reference.summary
        })}
      </article>`)
      .join("")}</div>
  </section>`;
}

function packageChecklist(title, items = []) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return `<section class="package-section">
    <h4>${esc(title)}</h4>
    <ul class="package-checklist">${items
      .map((item) => `<li class="${item.checked ? "checked" : "open"}">
        <span>${item.checked ? "✓" : "!"}</span>
        <p>${esc(item.label ?? item.title ?? item.id ?? item)}</p>
      </li>`)
      .join("")}</ul>
  </section>`;
}

function packageBrunchEditorial(editorial) {
  if (!editorial || typeof editorial !== "object") return "";
  const review = editorial.self_review ?? {};
  return `<section class="package-section brunch-editorial-contract">
    <h4>Brunch 편집 브리프</h4>
    ${keyValueList({
      유형: editorial.article_type,
      주제질문: editorial.topic_question,
      통념: editorial.common_belief,
      균열장면: editorial.disconfirming_scene,
      중심판단: editorial.central_judgment,
      독자행동: editorial.reader_action,
      화자: editorial.voice_profile
    })}
    ${editorial.central_case ? `<div class="package-case"><h5>중심 사례</h5>${keyValueList({
      상황: editorial.central_case.situation,
      관찰행동: editorial.central_case.observed_behavior,
      가능한원인: editorial.central_case.possible_causes,
      비교대안: editorial.central_case.alternatives,
      선택검증기준: editorial.central_case.selection_or_validation_criteria
    })}</div>` : ""}
    ${keyValueList({
      사고흐름: editorial.reasoning_flow,
      자가검수점수: `${review.total ?? 0}/36`,
      자가검수판정: review.result
    })}
  </section>`;
}

function packageInblogEditorial(editorial) {
  if (!editorial || typeof editorial !== "object") return "";
  const review = editorial.review ?? {};
  const plan = editorial.block_plan ?? {};
  return `<section class="package-section inblog-editorial-contract">
    <h4>공식 인블로그 편집 브리프</h4>
    ${keyValueList({
      유형: editorial.content_type,
      핵심검색어: editorial.primary_keyword,
      검색의도: editorial.search_intent,
      대상독자: editorial.target_audience,
      즉시실행: editorial.immediate_action,
      CTA대상: editorial.cta_target,
      제목유형: editorial.title_type,
      문체: editorial.tone_profile
    })}
    ${editorial.promised_answers?.length ? `<div class="package-case"><h5>독자가 얻을 답</h5>${packageChecklist("", editorial.promised_answers.map((label, index) => ({ id: `answer_${index + 1}`, label, checked: false })))}</div>` : ""}
    ${editorial.intro ? `<div class="package-case"><h5>도입부 흐름</h5>${keyValueList({
      독자상황: editorial.intro.reader_situation,
      검색질문: editorial.intro.reader_question,
      글의약속: editorial.intro.article_promise
    })}</div>` : ""}
    ${keyValueList({
      H2: plan.h2_count,
      콜아웃: plan.callout_count,
      정보비율: plan.info_ratio ? `${plan.info_ratio}%` : "",
      필수H2: plan.required_h2?.join(" · "),
      CTA: plan.cta_count
    })}
    ${keyValueList({
      자가검수: review.result,
      검색의도: review.single_search_intent,
      선제답변: review.answer_first,
      블록가독성: review.scannable_headings,
      사실검증: review.facts_verified,
      즉시행동: review.immediate_action,
      CTA종료배치: review.cta_single_end
    })}
  </section>`;
}

function packageImagePrompts(prompts = []) {
  if (!Array.isArray(prompts) || prompts.length === 0) return "";
  return `<section class="package-section">
    <h4>Image Prompts</h4>
    <div class="package-list">${prompts
      .map((prompt) => `<article>
        <h5>${esc(prompt.title ?? prompt.id)}</h5>
        <p>${esc(prompt.prompt ?? prompt.description ?? "")}</p>
        ${keyValueList({ usage: prompt.usage, negative_prompt: prompt.negative_prompt })}
      </article>`)
      .join("")}</div>
  </section>`;
}

function publishPackage(viewModel) {
  const pkg = viewModel.ui.package ?? {};
  const sections = getSections(viewModel);
  const hasStructuredPackage = Object.keys(pkg).length > 0;

  if (!hasStructuredPackage) {
    return `<div class="package-view section-package-view">
      <h3>${esc(viewModel.ui.title ?? "최종 패키지")}</h3>
      ${viewModel.ui.description ? `<p class="package-subtitle">${esc(viewModel.ui.description)}</p>` : ""}
      ${sections.map((section) => renderPackageUiSection(section, viewModel)).join("")}
      ${packageReferences(viewModel.stateSummary?.references)}
    </div>`;
  }

  const seo = keyValueList(pkg.seo ?? {});
  const cta = keyValueList(pkg.cta ?? {});
  const notionRow = keyValueList(pkg.notion_row ?? {});
  const metadata = keyValueList(pkg.metadata ?? {});

  return `<div class="package-view">
    <h3>${esc(pkg.title ?? viewModel.ui.title ?? "최종 패키지")}</h3>
    ${pkg.subtitle ? `<p class="package-subtitle">${esc(pkg.subtitle)}</p>` : ""}
    ${pkg.body_markdown ? editableWritingBlock({
      title: "최종 본문",
      markdown: pkg.body_markdown,
      sectionId: "publish_body",
      sourceStep: viewModel.step
    }) : ""}
    ${sections.length ? sections.map((section) => renderPackageUiSection(section, viewModel)).join("") : ""}
    ${seo ? `<section class="package-section"><h4>SEO</h4>${seo}</section>` : ""}
    ${cta ? `<section class="package-section"><h4>CTA</h4>${cta}</section>` : ""}
    ${packageBrunchEditorial(pkg.brunch_editorial)}
    ${packageInblogEditorial(pkg.inblog_editorial)}
    ${pkg.intro_options?.length ? packageChecklist("Brunch 도입 후보", pkg.intro_options.map((label, index) => ({ id: `intro_${index + 1}`, label, checked: false }))) : ""}
    ${pkg.thumbnail_copy_options?.length ? packageChecklist("Brunch 썸네일 문구 후보", pkg.thumbnail_copy_options.map((label, index) => ({ id: `thumb_${index + 1}`, label, checked: false }))) : ""}
    ${packageReferences(pkg.references ?? viewModel.stateSummary?.references)}
    ${packageChecklist("Checklist", pkg.checklist)}
    ${packageImagePrompts(pkg.image_prompts)}
    ${notionRow ? `<section class="package-section"><h4>Notion Row</h4>${notionRow}</section>` : ""}
    ${metadata ? `<section class="package-section"><h4>Metadata</h4>${metadata}</section>` : ""}
  </div>`;
}

const renderers = {
  option_grid: optionGrid,
  source_selection: sourceSelection,
  comparison_table: comparisonTable,
  checklist,
  outline_viewer: outlineViewer,
  draft_viewer: draftViewer,
  image_prompt_cards: imagePromptCards,
  publish_package: publishPackage
};

export function renderCurrentStep(viewModel) {
  assertKnownComponent(viewModel.ui.component);
  return renderers[viewModel.ui.component](viewModel);
}

export function renderCenterOptions(viewModel, { revealPending = false } = {}) {
  const options = viewModel.ui.options ?? [];
  return options
    .map((option, index) => {
      const selected = index === 0;
      return `<button class="center-option center-option-reveal ${selected ? "selected" : ""}${revealPending ? " center-option-reveal-pending" : ""}" type="button" data-option-id="${esc(option.id)}">
        <b>${index + 1}</b>
        <span>${esc(option.title)}</span>
      </button>`;
    })
    .join("");
}

export function renderActions(viewModel) {
  return `<button class="continue-button" type="button" data-selected-option-id="${esc(viewModel.selectedOptionId)}">계속 ↵</button>`;
}

export function escapeHtml(value) {
  return esc(value);
}
