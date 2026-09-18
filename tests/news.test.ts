import { describe, expect, it } from "vitest";
import { headlineKey, parseRss } from "../src/news.js";

const xml = `<?xml version="1.0"?>
<rss><channel>
  <item><title><![CDATA[Bitcoin hits $80K]]></title><pubDate>Mon, 15 Sep 2025 10:00:00 GMT</pubDate></item>
  <item><title>ETH ETF approved</title><pubDate>Mon, 15 Sep 2025 09:00:00 GMT</pubDate></item>
</channel></rss>`;

describe("parseRss", () => {
  it("extracts titles and ISO dates, CDATA included", () => {
    const [first, second] = parseRss(xml, "Test");
    expect(first).toEqual({ title: "Bitcoin hits $80K", source: "Test", publishedAt: "2025-09-15T10:00:00.000Z" });
    expect(second?.title).toBe("ETH ETF approved");
  });
});

describe("parseRss with body", () => {
  it("keeps the full message text as body next to the truncated title, and skips untitled media posts", () => {
    const feed = `<rss><channel>
      <item><title>I am hereby raising...</title><description><![CDATA[<p>I am hereby raising tariffs.</p><p>I have authorized a 90 day PAUSE.</p>]]></description><pubDate>Wed, 09 Apr 2025 17:18:00 GMT</pubDate></item>
      <item><title>[No Title] - Post from April 9, 2025</title><description></description><pubDate>Wed, 09 Apr 2025 17:00:00 GMT</pubDate></item>
    </channel></rss>`;
    expect(parseRss(feed, "Trump", true)).toEqual([
      { title: "I am hereby raising...", source: "Trump", publishedAt: "2025-04-09T17:18:00.000Z", body: "I am hereby raising tariffs. I have authorized a 90 day PAUSE." },
    ]);
    expect(parseRss(feed, "Trump")[0]?.body).toBeUndefined();
  });
});

describe("headlineKey", () => {
  it("tells apart recurring titles published on different dates", () => {
    const fomc = (publishedAt: string) => ({ title: "Federal Reserve issues FOMC statement", source: "Fed", publishedAt });
    expect(headlineKey(fomc("2026-07-29T18:00:00.000Z"))).not.toBe(headlineKey(fomc("2026-09-16T18:00:00.000Z")));
    expect(headlineKey(fomc("2026-09-16T18:00:00.000Z"))).toBe(headlineKey(fomc("2026-09-16T18:00:00.000Z")));
  });
});
