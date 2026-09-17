import { describe, expect, it } from "vitest";
import { dedupe, parseRss } from "../src/news.js";

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

describe("dedupe", () => {
  it("drops repeated titles case-insensitively", () => {
    const h = (title: string) => ({ title, source: "x", publishedAt: "" });
    expect(dedupe([h("A"), h("a"), h("B")])).toHaveLength(2);
  });
});
