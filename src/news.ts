import { XMLParser } from "fast-xml-parser";

export type Headline = { title: string; source: string; publishedAt: string };

const FEEDS = {
  CoinDesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  Cointelegraph: "https://cointelegraph.com/rss",
};

const parser = new XMLParser({ ignoreAttributes: true, cdataPropName: "__cdata" });

const text = (v: unknown): string =>
  typeof v === "object" && v !== null && "__cdata" in v ? String((v as { __cdata: unknown }).__cdata) : String(v ?? "");

export function parseRss(xml: string, source: string): Headline[] {
  const items = parser.parse(xml)?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items]).map((item) => ({
    title: text(item.title).trim(),
    source,
    publishedAt: new Date(text(item.pubDate)).toISOString(),
  }));
}

export function dedupe(headlines: Headline[]): Headline[] {
  const seen = new Set<string>();
  return headlines.filter((h) => !seen.has(h.title.toLowerCase()) && seen.add(h.title.toLowerCase()));
}

export async function fetchHeadlines(limit = 20): Promise<Headline[]> {
  const feeds = await Promise.all(
    Object.entries(FEEDS).map(async ([source, url]) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`RSS ${source}: ${res.status}`);
      return parseRss(await res.text(), source);
    }),
  );
  return dedupe(feeds.flat())
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}
