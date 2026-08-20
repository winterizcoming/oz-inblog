const DEFAULT_CHANNEL_ID = "3d65c9a3f2f742e";
const DEFAULT_ENDPOINT = `https://api.brunch.co.kr/v2/article/@${DEFAULT_CHANNEL_ID}?lastTime=0&thumbnail=Y&membershipContent=false`;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ARTICLES = 40;

function asIsoDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanText(value, maxLength = 600) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function normalizeBrunchArchivePayload(payload, {
  fetchedAt = new Date().toISOString(),
  channelId = DEFAULT_CHANNEL_ID,
  maxArticles = MAX_ARTICLES
} = {}) {
  const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
  const articles = list
    .filter((article) => article?.status === undefined || article.status === "publish")
    .map((article) => {
      const articleNo = Number(article.no);
      const publishedAt = asIsoDate(article.publishTime ?? article.createTime ?? article.updateTime);
      return {
        article_no: Number.isInteger(articleNo) && articleNo > 0 ? articleNo : null,
        url: Number.isInteger(articleNo) && articleNo > 0
          ? `https://brunch.co.kr/@${channelId}/${articleNo}`
          : null,
        title: cleanText(article.title, 220),
        subtitle: cleanText(article.subTitle, 300),
        summary: cleanText(article.contentSummary, 800),
        published_at: publishedAt
      };
    })
    .filter((article) => article.article_no && article.title && article.url)
    .sort((left, right) => String(right.published_at ?? "").localeCompare(String(left.published_at ?? "")))
    .slice(0, Math.min(Math.max(Number(maxArticles) || MAX_ARTICLES, 1), MAX_ARTICLES));

  return {
    status: articles.length ? "fresh" : "empty",
    channel_url: `https://brunch.co.kr/@${channelId}`,
    fetched_at: fetchedAt,
    latest_published_at: articles[0]?.published_at ?? null,
    article_count: articles.length,
    articles
  };
}

export async function fetchBrunchLiveArchive({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  channelId = DEFAULT_CHANNEL_ID,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(new Error("Brunch archive request timed out")), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "oz-inblog-automation-brunch-archive/0.7"
      },
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`Brunch archive request failed with status ${response?.status ?? "unknown"}`);
    const payload = await response.json();
    return normalizeBrunchArchivePayload(payload, {
      channelId,
      fetchedAt: new Date(now()).toISOString()
    });
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);
  }
}

export function archiveContextForPrompt(archive) {
  if (!archive || typeof archive !== "object") {
    return { status: "unavailable", articles: [], note: "라이브 아카이브를 확인하지 못했습니다. 로컬 snapshot은 참고 자료로만 사용하세요." };
  }
  return {
    status: archive.status,
    channel_url: archive.channel_url,
    fetched_at: archive.fetched_at,
    latest_published_at: archive.latest_published_at,
    article_count: archive.article_count,
    articles: Array.isArray(archive.articles) ? archive.articles : []
  };
}

export { DEFAULT_CHANNEL_ID, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS };
