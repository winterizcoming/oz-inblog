import crypto from "node:crypto";
import { extractLastJsonObject } from "../scripts/codex-provider-common.mjs";

const SOURCE_VERIFICATIONS = new Set(["opened_full_text", "snippet_only"]);

function nonEmptyText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function textSchema() {
  return { type: "string" };
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/iu.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

function sourceRole(sourceKind) {
  const kind = String(sourceKind ?? "").toLowerCase();
  if (/(official|primary|announcement|release|company)/u.test(kind)) return "official";
  if (/(academic|research|journal|paper)/u.test(kind)) return "research";
  if (/(news|journalism|report)/u.test(kind)) return "journalism";
  if (/(historical|archive)/u.test(kind)) return "historical";
  if (/(specialist|expert|analysis)/u.test(kind)) return "specialist";
  return "unspecified";
}

export function buildSourceDiscoveryAppServerOutputSchema() {
  const source = {
    type: "object",
    additionalProperties: false,
    required: ["url", "title", "published_at", "source_kind", "verification", "summary"],
    properties: {
      url: textSchema(),
      title: textSchema(),
      published_at: { type: ["string", "null"] },
      source_kind: textSchema(),
      verification: { type: "string", enum: [...SOURCE_VERIFICATIONS] },
      summary: textSchema()
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["query", "checked_at", "sources", "gaps"],
    properties: {
      query: textSchema(),
      checked_at: textSchema(),
      sources: { type: "array", maxItems: 4, items: source },
      gaps: { type: "array", items: textSchema() }
    }
  };
}

export function normalizeSourceDiscoveryBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source discovery bundle must be an object");
  if (!Array.isArray(value.sources) || value.sources.length > 4) throw new Error("source discovery sources must contain at most 4 items");
  if (!Array.isArray(value.gaps)) throw new Error("source discovery gaps must be an array");
  return {
    query: nonEmptyText(value.query, "query"),
    checked_at: nonEmptyText(value.checked_at, "checked_at"),
    sources: value.sources.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error(`sources ${index + 1} must be an object`);
      if (!SOURCE_VERIFICATIONS.has(source.verification)) throw new Error(`sources ${index + 1}.verification is invalid`);
      const url = canonicalizeUrl(nonEmptyText(source.url, `sources ${index + 1}.url`));
      const sourceKind = typeof source.source_kind === "string" && source.source_kind.trim()
        ? source.source_kind.trim()
        : "unspecified";
      return {
        id: typeof source.id === "string" && source.id.trim()
          ? source.id.trim()
          : `source-${crypto.createHash("sha256").update(url).digest("hex").slice(0, 12)}`,
        url,
        canonical_url: url,
        lead_url: url,
        origin_url: null,
        independence_key: url,
        source_role: sourceRole(sourceKind),
        title: nonEmptyText(source.title, `sources ${index + 1}.title`),
        ...(typeof source.published_at === "string" && source.published_at.trim() ? { published_at: source.published_at.trim() } : {}),
        source_kind: sourceKind,
        verification: source.verification,
        summary: nonEmptyText(source.summary, `sources ${index + 1}.summary`)
      };
    }).filter((source, index, sources) => sources.findIndex((candidate) => candidate.independence_key === source.independence_key) === index),
    gaps: value.gaps.map((gap, index) => nonEmptyText(gap, `gaps ${index + 1}`))
  };
}

export function verifiedAnchorsFromDiscovery(bundle) {
  return bundle.sources
    .filter((source) => source.verification === "opened_full_text")
    .map((source) => ({
      id: source.id,
      url: source.url,
      title: source.title,
      ...(source.published_at ? { published_at: source.published_at } : {}),
      source_kind: source.source_kind,
      canonical_url: source.canonical_url,
      lead_url: source.lead_url,
      origin_url: source.origin_url,
      independence_key: source.independence_key,
      source_role: source.source_role,
      source_confidence: "full_text",
      verified: true
    }));
}

export function parseSourceDiscoveryResponse(raw) {
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
    return { bundle: normalizeSourceDiscoveryBundle(JSON.parse(candidate)), parseMode, valid: true };
  } catch (error) {
    return {
      bundle: null,
      parseMode,
      valid: false,
      errorCode: "invalid_source_discovery",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export function buildSourceDiscoveryPrompt({ skillContent, archivePolicyContent, researchContext, previousSources = null, editorialContext = null, archiveContext = null }) {
  const titleLandscapeInstruction = researchContext?.research_mode === "title_landscape"
    ? "현재 검색 결과와 Surfit에서 실제로 겹칠 수 있는 제목·직무 키워드·유사 콘텐츠를 확인하세요. 검색 결과 페이지 자체가 아니라 연결된 원문을 열고, 제목 중복과 검색 의도를 판단할 수 있는 범위만 summary에 기록하세요."
    : "";
  const stableContext = typeof editorialContext === "string" && editorialContext.trim()
    ? ["\n--- 전체 편집 문맥(이 사용자 turn에서 한 번만 제공) ---", editorialContext]
    : ["\n--- 실제 SKILL.md ---\n", skillContent, "\n--- 조사 정책 ---\n", archivePolicyContent];
  return [
    "당신은 브런치 편집자를 위한 외부 원문 탐색기입니다.",
    "이번 호출에서는 웹 원문을 찾고 여는 일만 수행합니다. 논지, 글 방향, 구성, 초안은 만들지 마세요.",
    "주제에 직접 필요한 원문을 최대 4개만 확인하고 즉시 멈추세요. 공식·당사자 원문과 독립적인 최근 자료를 우선하되, 주제에 존재하지 않는 출처 유형을 억지로 채우지 마세요.",
    "검색 결과 제목이나 snippet만 본 자료는 verification=snippet_only로 기록하세요. 본문을 실제로 연 자료만 verification=opened_full_text로 기록하세요.",
    "summary에는 해당 원문이 직접 뒷받침하는 사실과 확인 범위만 적고, 편집자의 추론을 섞지 마세요.",
    "웹 검색은 이 자료 묶음을 채우는 데 필요한 범위에서만 사용하고, 최대 4개 자료를 확인하면 더 탐색하지 마세요.",
    titleLandscapeInstruction,
    ...stableContext,
    "\n--- 런타임에서 갱신한 브런치 아카이브(JSON) ---",
    JSON.stringify(archiveContext ?? { status: "unavailable", articles: [] }, null, 2),
    "라이브 아카이브가 있으면 로컬 snapshot보다 우선해 중복·후속 관계를 판단하세요. fetched_at과 published_at을 구분하고, 확인하지 못한 본문은 추측하지 마세요.",
    "\n--- 이번 조사에 필요한 편집 맥락(JSON) ---\n",
    JSON.stringify(researchContext, null, 2),
    "\n--- 이전 원문 탐색 결과(JSON, 있으면 보강 대상) ---\n",
    JSON.stringify(previousSources, null, 2),
    "단일 JSON 객체로 query, checked_at, sources, gaps만 반환하세요. sources는 최대 4개입니다."
  ].join("\n");
}
