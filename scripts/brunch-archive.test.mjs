import assert from "node:assert/strict";
import test from "node:test";
import { archiveContextForPrompt, fetchBrunchLiveArchive, normalizeBrunchArchivePayload } from "../lib/oz-brunch-live-archive.mjs";

test("live Brunch archive normalizes newest public metadata and publication dates", () => {
  const archive = normalizeBrunchArchivePayload({
    data: {
      list: [
        { no: 18, status: "publish", title: "오래된 글", subTitle: "부제", contentSummary: "요약", publishTime: 1_700_000_000_000 },
        { no: 19, status: "publish", title: "최신 글", subTitle: "새 부제", contentSummary: "새 요약", publishTime: 1_800_000_000_000 },
        { no: 20, status: "draft", title: "비공개", publishTime: 1_900_000_000_000 }
      ]
    }
  }, {
    channelId: "channel",
    fetchedAt: "2026-08-18T00:00:00.000Z"
  });

  assert.equal(archive.status, "fresh");
  assert.equal(archive.article_count, 2);
  assert.equal(archive.articles[0].article_no, 19);
  assert.equal(archive.articles[0].url, "https://brunch.co.kr/@channel/19");
  assert.equal(archive.articles[0].published_at, "2027-01-15T08:00:00.000Z");
  assert.equal(archive.fetched_at, "2026-08-18T00:00:00.000Z");
});

test("live archive fetch is injectable and exposes only bounded prompt context", async () => {
  const archive = await fetchBrunchLiveArchive({
    endpoint: "https://example.test/archive",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://example.test/archive");
      assert.equal(options.method, "GET");
      return {
        ok: true,
        async json() {
          return { data: { list: [{ no: 1, title: "글", contentSummary: "요약", publishTime: 1_800_000_000_000 }] } };
        }
      };
    },
    now: () => 1_800_000_000_000
  });
  const context = archiveContextForPrompt(archive);
  assert.equal(context.article_count, 1);
  assert.equal(context.articles[0].title, "글");
  assert.equal("content" in context.articles[0], false);
});
