import { XMLParser } from "fast-xml-parser";

export type Headline = { title: string; source: string; publishedAt: string };

// presse = article écrit après l'événement ; primaire = l'émetteur de l'événement lui-même
export type Source = { name: string; kind: "presse" | "primaire"; everySec: number; fetch: () => Promise<Headline[]> };

// Flux de presse, aussi utilisés par history.ts pour retrouver les titres d'époque
export const FEEDS = {
  CoinDesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  Cointelegraph: "https://cointelegraph.com/rss",
};

// La SEC exige un User-Agent identifiable ; Binance refuse les requêtes sans en-têtes de navigateur
const HEADERS = { "user-agent": "Mozilla/5.0 trading-bot-jev (github.com/Spykoninho/trading-bot-jev)", clienttype: "web", lang: "en" };

const parser = new XMLParser({ ignoreAttributes: true, cdataPropName: "__cdata" });

const text = (v: unknown): string =>
  typeof v === "object" && v !== null && "__cdata" in v ? String((v as { __cdata: unknown }).__cdata) : String(v ?? "");

export function parseRss(xml: string, source: string): Headline[] {
  const items = parser.parse(xml)?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items])
    .map((item) => ({ title: text(item.title).trim(), source, publishedAt: new Date(text(item.pubDate)) }))
    // Posts sans texte (image ou vidéo seule) et dates illisibles : rien à juger
    .filter((h) => h.title && !h.title.startsWith("[No Title]") && !Number.isNaN(h.publishedAt.getTime()))
    .map((h) => ({ ...h, publishedAt: h.publishedAt.toISOString() }));
}

export function dedupe(headlines: Headline[]): Headline[] {
  const seen = new Set<string>();
  return headlines.filter((h) => !seen.has(h.title.toLowerCase()) && seen.add(h.title.toLowerCase()));
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

const rss = (name: string, kind: Source["kind"], url: string, everySec: number): Source => ({
  name,
  kind,
  everySec,
  fetch: async () => parseRss(await (await get(url)).text(), name),
});

// Annonces officielles Binance : catalogue 48 = nouveaux listings, 161 = retraits de cotation
const binance = (name: string, catalogs: number[], everySec: number): Source => ({
  name,
  kind: "primaire",
  everySec,
  fetch: async () => {
    const pages = await Promise.all(
      catalogs.map(async (id) => {
        const res = await get(`https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${id}&pageNo=1&pageSize=20`);
        const body = (await res.json()) as { data?: { catalogs?: { articles?: { title: string; releaseDate: number }[] }[] } };
        return body.data?.catalogs?.[0]?.articles ?? [];
      }),
    );
    return pages.flat().map((a) => ({ title: a.title, source: name, publishedAt: new Date(a.releaseDate).toISOString() }));
  },
});

export const SOURCES: Source[] = [
  rss("CoinDesk", "presse", FEEDS.CoinDesk, 60),
  rss("Cointelegraph", "presse", FEEDS.Cointelegraph, 60),
  binance("Binance (annonces)", [48, 161], 30),
  rss("SEC (communiqués)", "primaire", "https://www.sec.gov/news/pressreleases.rss", 60),
  rss("Fed (communiqués)", "primaire", "https://www.federalreserve.gov/feeds/press_all.xml", 30),
  rss("Trump (Truth Social)", "primaire", "https://trumpstruth.org/feed", 30),
];
