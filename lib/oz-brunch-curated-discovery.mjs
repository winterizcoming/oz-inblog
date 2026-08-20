import crypto from "node:crypto";
import { extractLastJsonObject } from "../scripts/codex-provider-common.mjs";
import { normalizeResponse } from "./oz-brunch-response.mjs";
import { curatedDiscoverySourcePoolForPrompt } from "./oz-brunch-discovery-sources.mjs";

const RETRY_LABEL = "모두 별로예요. 다시 찾아주세요";
const OUTLINE_ACTION_LABEL = "목차 작성";
const ARTICLE_ACTION_LABEL = "이 구성으로 전체 원고 작성";

function actionChoice(label, description) {
  return { label, description };
}

function dateWindow(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const end = new Date(now);
  const start = new Date(end.getTime() - (7 * 24 * 60 * 60 * 1000));
  return { today: formatter.format(end), since: formatter.format(start) };
}

function historyContext(history, userMessage) {
  return [
    "--- 필요한 대화 문맥(JSON) ---",
    JSON.stringify(history ?? [], null, 2),
    "--- 현재 사용자 메시지 ---",
    userMessage
  ].join("\n");
}

function responseContract() {
  return [
    "응답은 JSON 객체 하나만 반환하세요. JSON 바깥에 설명이나 코드 블록을 붙이지 마세요.",
    '{"markdown":"사용자에게 보여줄 응답","question":"필요한 질문","choices":[{"label":"짧은 사건명","description":"짧은 설명"}],"writing_preview":null,"next_action":"none"} 형태를 사용하세요.',
    "markdown은 비어 있지 않은 문자열이어야 합니다. choices는 선택지가 필요할 때만 사용하고, 각 choice에는 label과 description을 넣으세요. writing_preview는 원고 작성 때만 사용하세요. next_action은 none, outline, article 중 하나로 반환하세요."
  ].join("\n");
}

export function buildCuratedEditAppServerOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["markdown", "question", "choices", "writing_preview", "next_action"],
    properties: {
      markdown: { type: "string", minLength: 1 },
      question: { type: ["string", "null"] },
      choices: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "description"],
          properties: { label: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } }
        }
      },
      writing_preview: {
        anyOf: [{
          type: "object",
          additionalProperties: false,
          required: ["title", "subtitle", "markdown"],
          properties: {
            title: { type: "string", minLength: 1 },
            subtitle: { type: ["string", "null"] },
            markdown: { type: "string", minLength: 1 }
          }
        }, { type: "null" }]
      },
      next_action: { type: "string", enum: ["none", "outline", "article"] }
    }
  };
}

function nullableText() {
  return { type: ["string", "null"] };
}

function sourceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["url", "title", "published_at", "source_kind", "verification", "summary"],
    properties: {
      url: { type: "string" },
      title: { type: "string" },
      published_at: nullableText(),
      source_kind: { type: "string" },
      verification: { type: "string", enum: ["opened_full_text", "snippet_only"] },
      summary: { type: "string" }
    }
  };
}

function curatedSeedSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "seed_publication", "seed_title", "seed_url", "published_at", "event", "why_interesting", "archive_relation", "design_topic_kind", "design_analysis_hook"],
    properties: {
      label: { type: "string" },
      seed_publication: { type: "string" },
      seed_title: { type: "string" },
      seed_url: { type: "string" },
      published_at: nullableText(),
      event: { type: "string" },
      why_interesting: { type: "string" },
      archive_relation: { type: "string", enum: ["new", "follow_up", "duplicate", "unknown"] },
      design_topic_kind: { type: "string", enum: ["brand_change", "product_experience_change", "design_decision", "screen_or_service_change", "design_practice", "none"] },
      design_analysis_hook: nullableText()
    }
  };
}

function sourceCheckSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "attempted", "reason", "listing_url", "query", "article_open_count"],
    properties: {
      source_id: { type: "string" },
      attempted: { type: "boolean" },
      reason: nullableText(),
      listing_url: nullableText(),
      query: nullableText(),
      article_open_count: { type: "integer", minimum: 0 }
    }
  };
}

export function buildCuratedDiscoveryAppServerOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["query", "checked_at", "sources", "gaps", "seeds", "source_checks", "article_opens", "archive_duplicate_exclusions", "finish_reason"],
    properties: {
      query: { type: "string" },
      checked_at: { type: "string" },
      sources: { type: "array", items: sourceSchema() },
      gaps: { type: "array", items: { type: "string" } },
      seeds: { type: "array", items: curatedSeedSchema() },
      source_checks: { type: "array", items: sourceCheckSchema() },
      article_opens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title", "published_at", "source_id"],
          properties: { url: { type: "string" }, title: { type: "string" }, published_at: nullableText(), source_id: { type: "string" } }
        }
      },
      archive_duplicate_exclusions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "seed_url", "reason"],
          properties: { label: { type: "string" }, seed_url: { type: "string" }, reason: { type: "string" } }
        }
      },
      finish_reason: { type: "string", enum: ["source_pool_completed", "time_budget", "article_open_budget", "manual_finish"] }
    }
  };
}

function curatedResearchFindingSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["statement", "source_refs"],
    properties: { statement: { type: "string" }, source_refs: { type: "array", items: { type: "string" } } }
  };
}

export function buildCuratedResearchAppServerOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["topic", "seed", "checked_at", "findings", "scenes", "reactions", "background", "unknowns"],
    properties: {
      topic: { type: "string" },
      seed: {
        type: "object",
        additionalProperties: false,
        required: ["label", "seed_publication", "seed_title", "seed_url", "published_at", "event", "why_interesting"],
        properties: {
          label: { type: "string" },
          seed_publication: { type: "string" },
          seed_title: { type: "string" },
          seed_url: { type: "string" },
          published_at: nullableText(),
          event: { type: "string" },
          why_interesting: { type: "string" }
        }
      },
      checked_at: { type: "string" },
      findings: { type: "array", items: curatedResearchFindingSchema() },
      scenes: { type: "array", items: curatedResearchFindingSchema() },
      reactions: { type: "array", items: curatedResearchFindingSchema() },
      background: { type: "array", items: curatedResearchFindingSchema() },
      unknowns: { type: "array", items: { type: "string" } }
    }
  };
}

function parseJsonObject(raw, errorCode) {
  const text = String(raw ?? "").trim();
  let candidate = text;
  let parseMode = "json";
  try {
    JSON.parse(candidate);
  } catch {
    candidate = extractLastJsonObject(text);
    parseMode = "json-object";
  }
  try {
    const value = JSON.parse(candidate);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
    return { value, parseMode, valid: true };
  } catch (error) {
    return { value: null, parseMode, valid: false, errorCode, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export function parseCuratedEditResponse(raw) {
  const parsed = parseJsonObject(raw, "invalid_curated_edit");
  if (!parsed.valid) return { response: null, parseMode: parsed.parseMode, valid: false, errorCode: parsed.errorCode, errorMessage: parsed.errorMessage };
  try {
    const value = parsed.value;
    return {
      response: normalizeResponse({
        markdown: value.markdown || "이번 탐색에서 확인한 내용을 정리했습니다.",
        question: value.question || "어떤 글감으로 이어갈까요?",
        choices: Array.isArray(value.choices) ? value.choices : [],
        ...(value.writing_preview ? { writing_preview: value.writing_preview } : {})
      }),
      nextAction: ["none", "outline", "article"].includes(value.next_action) ? value.next_action : "none",
      parseMode: parsed.parseMode,
      valid: true
    };
  } catch (error) {
    return { response: null, parseMode: parsed.parseMode, valid: false, errorCode: "invalid_curated_edit", errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function nullable(value) {
  return value === null || value === undefined || value === "" ? null : nonEmpty(value, "published_at");
}

function candidateId(seed) {
  return `seed-${crypto.createHash("sha256").update(`${seed.seed_url}\u0000${seed.seed_title}`, "utf8").digest("hex").slice(0, 12)}`;
}

function normalizeSeed(seed, index) {
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) throw new Error(`seeds ${index + 1} must be an object`);
  const normalized = {
    candidate_id: candidateId(seed),
    label: nonEmpty(seed.label, `seeds ${index + 1}.label`),
    seed_publication: nonEmpty(seed.seed_publication, `seeds ${index + 1}.seed_publication`),
    seed_title: nonEmpty(seed.seed_title, `seeds ${index + 1}.seed_title`),
    seed_url: nonEmpty(seed.seed_url, `seeds ${index + 1}.seed_url`),
    published_at: nullable(seed.published_at),
    event: nonEmpty(seed.event, `seeds ${index + 1}.event`),
    why_interesting: nonEmpty(seed.why_interesting, `seeds ${index + 1}.why_interesting`),
    archive_relation: ["new", "follow_up", "duplicate", "unknown"].includes(seed.archive_relation) ? seed.archive_relation : "unknown",
    design_topic_kind: ["brand_change", "product_experience_change", "design_decision", "screen_or_service_change", "design_practice", "none"].includes(seed.design_topic_kind) ? seed.design_topic_kind : "none",
    design_analysis_hook: nullable(seed.design_analysis_hook)
  };
  return normalized;
}

function normalizeCuratedSources(value) {
  const sources = (Array.isArray(value.sources) ? value.sources : []).map((source, index) => {
    const url = nonEmpty(source?.url, `sources ${index + 1}.url`).split("#")[0];
    return {
      id: `source-${crypto.createHash("sha256").update(url, "utf8").digest("hex").slice(0, 12)}`,
      url,
      canonical_url: url,
      lead_url: url,
      origin_url: null,
      independence_key: url,
      source_role: "discovery",
      title: nonEmpty(source?.title, `sources ${index + 1}.title`),
      published_at: nullable(source?.published_at),
      source_kind: nonEmpty(source?.source_kind, `sources ${index + 1}.source_kind`),
      verification: source?.verification === "opened_full_text" ? "opened_full_text" : "snippet_only",
      summary: nonEmpty(source?.summary, `sources ${index + 1}.summary`)
    };
  }).filter((source, index, all) => all.findIndex((candidate) => candidate.independence_key === source.independence_key) === index);
  return {
    query: nonEmpty(value.query, "query"),
    checked_at: nonEmpty(value.checked_at, "checked_at"),
    sources,
    gaps: (Array.isArray(value.gaps) ? value.gaps : []).map((gap, index) => nonEmpty(gap, `gaps ${index + 1}`))
  };
}

export function parseCuratedDiscoveryResponse(raw) {
  const parsed = parseJsonObject(raw, "invalid_curated_discovery");
  if (!parsed.valid) return parsed;
  try {
    const base = normalizeCuratedSources(parsed.value);
    const seeds = (Array.isArray(parsed.value.seeds) ? parsed.value.seeds : []).map(normalizeSeed);
    const sourceChecks = (Array.isArray(parsed.value.source_checks) ? parsed.value.source_checks : []).map((check, index) => ({
      source_id: nonEmpty(check.source_id, `source_checks ${index + 1}.source_id`),
      attempted: check.attempted === true,
      reason: check.reason === null || check.reason === undefined || check.reason === "" ? null : nonEmpty(check.reason, `source_checks ${index + 1}.reason`),
      listing_url: check.listing_url === null || check.listing_url === undefined || check.listing_url === "" ? null : nonEmpty(check.listing_url, `source_checks ${index + 1}.listing_url`),
      query: check.query === null || check.query === undefined || check.query === "" ? null : nonEmpty(check.query, `source_checks ${index + 1}.query`),
      article_open_count: Number.isInteger(check.article_open_count) && check.article_open_count >= 0 ? check.article_open_count : 0
    }));
    const articleOpens = (Array.isArray(parsed.value.article_opens) ? parsed.value.article_opens : []).map((entry, index) => ({
      url: nonEmpty(entry.url, `article_opens ${index + 1}.url`),
      title: nonEmpty(entry.title, `article_opens ${index + 1}.title`),
      published_at: nullable(entry.published_at),
      source_id: nonEmpty(entry.source_id, `article_opens ${index + 1}.source_id`)
    }));
    const exclusions = (Array.isArray(parsed.value.archive_duplicate_exclusions) ? parsed.value.archive_duplicate_exclusions : []).map((entry, index) => ({
      label: nonEmpty(entry.label, `archive_duplicate_exclusions ${index + 1}.label`),
      seed_url: nonEmpty(entry.seed_url, `archive_duplicate_exclusions ${index + 1}.seed_url`),
      reason: nonEmpty(entry.reason, `archive_duplicate_exclusions ${index + 1}.reason`)
    }));
    const finishReason = ["source_pool_completed", "time_budget", "article_open_budget", "manual_finish"].includes(parsed.value.finish_reason)
      ? parsed.value.finish_reason
      : "source_pool_completed";
    return {
      bundle: { ...base, seeds, source_checks: sourceChecks, article_opens: articleOpens, archive_duplicate_exclusions: exclusions, finish_reason: finishReason },
      parseMode: parsed.parseMode,
      valid: true
    };
  } catch (error) {
    return { bundle: null, parseMode: parsed.parseMode, valid: false, errorCode: "invalid_curated_discovery", errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeFindingList(value, field) {
  return (Array.isArray(value) ? value : []).map((entry, index) => ({
    statement: nonEmpty(entry?.statement, `${field} ${index + 1}.statement`),
    source_refs: Array.isArray(entry?.source_refs) ? entry.source_refs.map((ref, refIndex) => nonEmpty(ref, `${field} ${index + 1}.source_refs ${refIndex + 1}`)) : []
  }));
}

export function parseCuratedResearchResponse(raw) {
  const parsed = parseJsonObject(raw, "invalid_curated_research");
  if (!parsed.valid) return parsed;
  try {
    const value = parsed.value;
    return {
      bundle: {
        topic: nonEmpty(value.topic, "topic"),
        seed: value.seed && typeof value.seed === "object" ? value.seed : {},
        checked_at: nonEmpty(value.checked_at, "checked_at"),
        findings: normalizeFindingList(value.findings, "findings"),
        scenes: normalizeFindingList(value.scenes, "scenes"),
        reactions: normalizeFindingList(value.reactions, "reactions"),
        background: normalizeFindingList(value.background, "background"),
        unknowns: (Array.isArray(value.unknowns) ? value.unknowns : []).map((entry, index) => nonEmpty(entry, `unknowns ${index + 1}`))
      },
      parseMode: parsed.parseMode,
      valid: true
    };
  } catch (error) {
    return { bundle: null, parseMode: parsed.parseMode, valid: false, errorCode: "invalid_curated_research", errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

export function buildCuratedDiscoveryPrompt({ userMessage, archiveContext, rejectedTopics = [], sourcePool = curatedDiscoverySourcePoolForPrompt(), now = new Date() }) {
  const window = dateWindow(now);
  return [
    "당신은 브런치 글감의 첫 탐색을 맡은 큐레이션 레이더입니다.",
    "이번 단계의 목적은 최근 디자인 관련 사건과 아티클 seed를 넓고 얕게 발견하는 것입니다. 중심 질문, 편집적 판단, 방향, 결론, 목차를 만들지 마세요.",
    `오늘은 ${window.today}입니다. 일반 기사와 기업 디자인 채널은 ${window.since}부터 오늘까지를 우선 확인하세요. 이 기간에 좋은 후보가 적으면 오래된 후보로 채우지 말고 적은 수만 반환하세요. Academic lane만 최근 30일까지 허용합니다.`,
    "아래 source pool의 recent listing/index/headline을 먼저 훑으세요. 제목과 날짜만으로 충분하지 않은 흥미로운 seed만 개별 본문 URL을 열어 확인하고, discovery 전체의 article open은 최대 15개로 제한하세요. pagination은 하지 않습니다. seed_url은 가능하면 listing/index가 아닌 실제 기사·프로젝트 URL을 사용하고, 직접 URL을 확인하지 못한 후보는 gaps에 남기세요.",
    "가능한 source pool 항목의 최근 listing을 하나의 넓은 webSearch 호출에 함께 묶어 확인하세요. webSearch는 그 첫 호출과 source pool 접근이 빠진 것이 명확할 때의 한 번의 expansion까지만 허용합니다. 그 결과에서 필요한 listing/article만 openPage로 확인하고, 같은 의미의 추가 webSearch는 반복하지 마세요. 결과가 부족해도 오래된 자료나 generic trend 검색으로 채우지 마세요. finish steer 또는 time budget이 오면 새 검색을 시작하지 말고 지금까지의 결과를 JSON으로 마무리하세요.",
    "공식 newsroom, release note, help page를 Discovery의 기본 출발점으로 삼지 마세요. Toss·당근·오늘의집의 디자인/제품 아티클 채널은 예외입니다. 공식 사실 검증은 사용자가 seed를 고른 다음 단계로 미룹니다.",
    "generic한 'AI 시대 디자인'·'디자인 시스템의 미래' 검색으로 빠지지 마세요. 같은 의미의 검색을 반복하지 마세요.",
    "후보는 실제 회사·제품·프로젝트·화면·리디자인·브랜드 변경·업계 논쟁·사용자 반응·논문처럼 구체적인 seed여야 합니다. label은 회사/제품/프로젝트와 실제 사건을 짧게 붙여 쓰세요. design_topic_kind는 brand_change, product_experience_change, design_decision, screen_or_service_change, design_practice, none 중 하나로 표시하고, 디자인 분석 대상이 없으면 none과 null hook을 사용하세요. 디자인 관찰 지점이 없는 일반 기술 소개는 후보로 만들지 마세요.",
    "아카이브는 검색 범위를 정하는 입력이 아닙니다. 후보를 발견한 뒤 같은 사건/같은 논지의 중복인지, 실제 새 후속 사건인지 비교하세요.",
    "탐색 전체의 안전 예산은 15분입니다. source listing 확인은 앞의 10분 source stage 안에서 끝내고, 약 9분에 finish steer가 오면 새 검색을 시작하지 말고 남은 시간에 지금까지 확인한 결과를 JSON으로 닫으세요. 후보 개수는 종료 조건이 아닙니다.",
    "source_checks에는 source pool 각 항목의 attempted 여부와 생략 이유를 남기고, article_opens에는 실제 연 본문만 남기세요. 관측하지 못한 값은 추측하지 말고 빈 배열 또는 unknown 성격의 note로 남기세요.",
    "최종 JSON의 seeds에는 label, seed_publication, seed_title, seed_url, published_at, event, why_interesting, archive_relation만 사용하세요. why_interesting은 한두 문장으로 제한하고 논지를 만들지 마세요.",
    "--- source pool(JSON) ---",
    JSON.stringify(sourcePool, null, 2),
    "--- 현재 브런치 아카이브(JSON, 후보 발견 후 중복 확인용) ---",
    JSON.stringify(archiveContext ?? { status: "unavailable", articles: [] }, null, 2),
    "--- 이미 제외한 주제 ---",
    JSON.stringify(rejectedTopics),
    historyContext([], userMessage),
    "단일 JSON 객체로 query, checked_at, sources, gaps, seeds, source_checks, article_opens, archive_duplicate_exclusions, finish_reason을 반환하세요. sources는 발견용 원문이며 verification=opened_full_text 또는 snippet_only를 표시하세요. 각 seed에는 design_topic_kind와 design_analysis_hook도 포함하세요."
  ].join("\n");
}

export function buildCuratedDiscoveryEditPrompt({ history, userMessage, discoveryBundle, archiveContext }) {
  const seeds = discoveryBundle?.seeds ?? [];
  return [
    "당신은 글감 후보를 함께 고르는 브런치 편집자입니다.",
    "검색 보고서나 방법론을 다시 설명하지 말고, 사용자가 무엇을 고를지 판단할 수 있게 자연스럽게 이야기하세요.",
    "Research가 준 모든 seed를 choices에 하나씩 보존하세요. 후보를 탈락시키거나 숨기지 마세요. markdown은 Conversation의 본문이므로 모든 후보를 사용자가 판단할 수 있을 만큼 다루고, 각 후보에서 실제로 무슨 일이 있었는지와 왜 흥미롭거나 약한지에 대한 의견을 중요도에 따라 자연스럽게 설명하세요. 모든 후보를 같은 길이와 같은 형식으로 쓰지 않아도 됩니다.",
    "choice label은 seed.label을 그대로 사용하세요. 철학적 질문, 결론, 추상적 인사이트, 'A가 아니라 B' 식의 카피를 label로 만들지 마세요. 최종 선택은 사용자에게 남기고, 마지막 choice는 반드시 모두 별로예요 재탐색 action으로 둡니다.",
    "공개 markdown에 source list, methodology, 긴 archive 비교표를 출력하지 마세요. 근거 링크는 기본 응답에 넣지 말고 seed의 사건과 편집 의견을 전달하세요. choice.description은 markdown을 대신하지 않는 짧은 보조 정보만 넣으세요.",
    historyContext(history, userMessage),
    "--- Research seed payload(JSON) ---",
    JSON.stringify(seeds, null, 2),
    "--- archive relation(JSON, 이미 Runtime이 계산한 값) ---",
    JSON.stringify((seeds ?? []).map((seed) => ({ label: seed.label, archive_relation: seed.archive_relation })), null, 2),
    JSON.stringify(archiveContext ?? { status: "unavailable" }, null, 2),
    responseContract(),
    "유효한 seed가 0개면 최근 7일 안에 강한 후보를 찾지 못했다고 솔직하게 말하고 choices에는 재탐색 choice만 넣으세요. writing_preview는 만들지 마세요."
  ].join("\n");
}

export function buildCuratedResearchSourcePrompt({ history, userMessage, seed, previousSources = null, archiveContext }) {
  return [
    "당신은 사용자가 고른 하나의 디자인 사건을 검증하기 위한 원문 탐색기입니다.",
    "이제부터는 seed를 버리고 처음부터 새 글감을 찾지 않습니다. seed article을 출발점으로 공식 발표, 1차 자료, 디자인팀/에이전시 원문, 다른 매체와 필요한 사용자·업계 반응을 확인하세요.",
    "실제로 무슨 일이 있었는지 확인하는 데 필요한 원문만 찾고, 검색 결과 제목이나 snippet만 본 자료는 snippet_only로 표시하세요. 본문을 연 자료만 opened_full_text입니다. 이 단계에서도 중심 질문·방향·목차·결론을 만들지 마세요.",
    "원문은 필요한 만큼만 확인하세요. 같은 출처를 반복하지 말고 확인하지 못한 내용은 gaps로 남기세요.",
    "--- 선택된 seed(JSON) ---",
    JSON.stringify(seed ?? null, null, 2),
    "--- 기존 discovery sources(JSON) ---",
    JSON.stringify(previousSources ?? null, null, 2),
    "--- archive(JSON) ---",
    JSON.stringify(archiveContext ?? { status: "unavailable" }, null, 2),
    historyContext(history, userMessage),
    "단일 JSON 객체로 query, checked_at, sources, gaps만 반환하세요. sources의 각 항목은 url, title, published_at, source_kind, verification, summary를 포함해야 합니다."
  ].join("\n");
}

export function buildCuratedResearchPrompt({ history, userMessage, seed, sourceDiscovery, previousResearch = null }) {
  return [
    "당신은 선택된 디자인 사건을 확인하는 리서처입니다.",
    "이번 출력은 사용자에게 보일 결론이나 방향이 아니라, 확인한 사실을 대화에 쓸 수 있게 정리한 조사 메모입니다. 중심 질문, editorial judgment, possible directions, 목차를 만들지 마세요.",
    "웹 검색을 직접 사용해 seed article의 공식 발표·1차 자료와 필요한 다른 매체를 확인하세요. 공식 source가 검색되지 않으면 그 사실을 unknowns에 남기고 추측하지 마세요. 검색은 이 seed의 검증에만 사용하세요.",
    "seed article이 무엇에 주목했는지, 공식 자료가 무엇이라고 하는지, 다른 매체나 반응이 무엇을 더 보여주는지, 필요한 배경과 실제 장면을 확인하세요. 확인되지 않은 내용은 unknowns에 남기세요.",
    "각 finding과 scene/reaction/background는 source_refs로 확인한 source URL 또는 source id를 가리키세요. 사실을 일반적인 AI/디자인 교훈으로 확장하지 마세요.",
    "--- 선택된 seed(JSON) ---",
    JSON.stringify(seed ?? null, null, 2),
    "--- 확인한 원문(JSON) ---",
    JSON.stringify(sourceDiscovery ?? null, null, 2),
    "--- 이전 조사 메모(JSON) ---",
    JSON.stringify(previousResearch ?? null, null, 2),
    historyContext(history, userMessage),
    "단일 JSON 객체로 topic, seed, checked_at, findings, scenes, reactions, background, unknowns를 반환하세요."
  ].join("\n");
}

export function buildCuratedResearchResponsePrompt({ history, userMessage, seed, researchBundle }) {
  return [
    "당신은 사용자가 고른 사건을 함께 살펴보는 편집자입니다.",
    "확인한 내용을 평범한 대화처럼 설명하세요. 논문식 evidence report, source ledger, 안정성 등급, 방향 선택지를 만들지 마세요.",
    "seed에서 출발해 새로 확인된 사실 중 가장 흥미로운 장면 하나를 먼저 말하고, 이 사건으로 글을 이어갈 만한지 본인의 의견을 짧게 덧붙이세요. 확인되지 않은 주장은 공개 답변에서 만들지 말고, 사용자의 판단에 꼭 필요한 경우에만 짧게 한계를 표시하세요. 좋은 발견을 불필요한 disclaimer로 끝내지 마세요.",
    "응답이 길어져 정보 위계가 필요할 때만 발견한 내용, 디자인 관점, 다음 단계처럼 역할이 드러나는 짧은 Markdown heading을 사용할 수 있습니다. 짧은 대화는 평범한 문단으로 유지하세요.",
    "사용자가 생각을 바꿀 수 있도록 열어 두고, 조사가 충분해 다음 행동을 명확히 제안할 수 있을 때만 마지막에 목차 진행 여부를 물으세요. 그때 choices에는 목차 진행 action 하나만 넣고, 방향 후보를 choices로 만들지 마세요. 다음 행동이 아직 열려 있으면 choices를 비워 두세요.",
    `선택된 seed: ${JSON.stringify(seed ?? null)}`,
    historyContext(history, userMessage),
    "--- 조사 메모(JSON) ---",
    JSON.stringify(researchBundle ?? null, null, 2),
    responseContract(),
    "writing_preview는 만들지 마세요."
  ].join("\n");
}

export function normalizeCuratedDiscoveryResponse(response, seeds) {
  const safeSeeds = Array.isArray(seeds) ? seeds : [];
  const modelChoices = Array.isArray(response?.choices) ? response.choices : [];
  const choices = safeSeeds.map((seed) => {
    const match = modelChoices.find((choice) => String(choice?.label ?? "").trim() === seed.label)
      ?? modelChoices.find((choice) => String(choice?.label ?? "").includes(seed.label) || seed.label.includes(String(choice?.label ?? "").trim()));
    return {
      label: seed.label,
      description: shortChoiceDescription(seed, match?.description)
    };
  });
  const missingMentions = safeSeeds.filter((seed) => {
    const markdown = String(response?.markdown ?? "");
    const hasLabel = markdown.includes(seed.label) || markdown.includes(seed.seed_title);
    const hasDetail = markdown.includes(seed.event) || markdown.includes(seed.why_interesting);
    return !hasLabel || !hasDetail;
  });
  const coverage = missingMentions.length > 0
    ? `\n\n${missingMentions.map((seed) => `${seed.label}\n${seed.event} ${seed.why_interesting}`).join("\n\n")}`
    : "";
  return normalizeResponse({
    markdown: `${response?.markdown ?? "이번 탐색에서 확인한 후보를 정리했습니다."}${coverage}`,
    question: response?.question || (safeSeeds.length ? "어떤 글감으로 이어갈까요?" : "최근 7일 안에 강한 후보를 찾지 못했습니다. 다시 찾아볼까요?"),
    choices: [...choices, { label: RETRY_LABEL, description: "이 후보들을 제외하고 다른 최근 글감을 다시 찾습니다." }]
  });
}

function shortChoiceDescription(seed, modelDescription) {
  const event = String(seed?.event ?? "").trim();
  if (event) return event.length > 96 ? `${event.slice(0, 93)}...` : event;
  const fallback = String(seed?.why_interesting ?? modelDescription ?? "").trim();
  return fallback.length > 96 ? `${fallback.slice(0, 93)}...` : fallback;
}

export function normalizeCuratedConversationResponse(response, { nextAction = "none" } = {}) {
  const question = response?.question || "이 정도면 목차를 잡아볼까요?";
  const choices = nextAction === "outline"
    ? [actionChoice(OUTLINE_ACTION_LABEL, "확인한 자료를 바탕으로 글의 구성을 정리합니다.")]
    : [];
  return normalizeResponse({
    markdown: response?.markdown || "확인한 내용을 정리했습니다.",
    question,
    choices
  });
}

export function normalizeCuratedOutlineResponse(response, { nextAction = "none" } = {}) {
  const question = response?.question || "이 구성으로 전체 원고를 작성할까요?";
  const choices = String(response?.markdown ?? "").trim() && nextAction === "article"
    ? [actionChoice(ARTICLE_ACTION_LABEL, "확정한 구성과 확인한 자료를 전체 원고로 작성합니다.")]
    : [];
  return normalizeResponse({
    markdown: response?.markdown || "확인한 구성으로 목차를 정리했습니다.",
    question,
    choices
  });
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/u, "").toLowerCase();
  } catch {
    return String(value ?? "").trim().replace(/#.*$/u, "").replace(/\/$/u, "").toLowerCase();
  }
}

function normalizedArchiveText(value) {
  return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function dedupeCuratedSeedsAgainstArchive(seeds, archiveContext) {
  const articles = Array.isArray(archiveContext?.articles) ? archiveContext.articles : [];
  if (articles.length === 0) return { seeds: Array.isArray(seeds) ? seeds : [], exclusions: [] };
  const archiveUrls = new Set(articles.map((article) => canonicalUrl(article?.url || article?.canonical_url)).filter(Boolean));
  const archiveTitles = new Set(articles.map((article) => normalizedArchiveText(article?.title)).filter(Boolean));
  const exclusions = [];
  const kept = (Array.isArray(seeds) ? seeds : []).filter((seed) => {
    const seedUrl = canonicalUrl(seed?.seed_url);
    const seedTitle = normalizedArchiveText(seed?.seed_title || seed?.label);
    let reason = null;
    if (seed?.archive_relation === "duplicate") reason = "model_marked_duplicate";
    else if (seedUrl && archiveUrls.has(seedUrl)) reason = "archive_url_match";
    else if (seedTitle && archiveTitles.has(seedTitle)) reason = "archive_title_match";
    if (!reason) return true;
    exclusions.push({ label: seed.label, seed_url: seed.seed_url, reason });
    return false;
  });
  return { seeds: kept, exclusions };
}

export function validateCuratedCandidateFit(seed) {
  const kind = seed?.design_topic_kind;
  if (kind === "none") return { valid: false, reason: "no_design_fit" };
  if (!["brand_change", "product_experience_change", "design_decision", "screen_or_service_change", "design_practice"].includes(kind)) {
    return { valid: false, reason: "invalid_design_topic_kind" };
  }
  if (typeof seed?.design_analysis_hook !== "string" || !seed.design_analysis_hook.trim()) {
    return { valid: false, reason: "missing_design_analysis_hook" };
  }
  return { valid: true, reason: null };
}

export { RETRY_LABEL };
