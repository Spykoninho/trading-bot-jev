import { XMLParser } from "fast-xml-parser";

// `body` = texte complet quand la source le fournit : Jev juge le contenu, pas seulement le titre
export type Headline = { title: string; source: string; publishedAt: string; body?: string; link?: string };

// presse = article écrit après l'événement ; primaire = l'émetteur lui-même ; `fetchBody` = texte complet absent du flux
export type Source = { name: string; kind: "presse" | "primaire"; everySec: number; fetch: () => Promise<Headline[]>; fetchBody?: (h: Headline) => Promise<string> };

// Flux de presse, aussi utilisés par history.ts pour retrouver les titres d'époque
export const FEEDS = {
  CoinDesk: "https://www.coindesk.com/arc/outboundfeeds/rss/",
  Cointelegraph: "https://cointelegraph.com/rss",
};

// La SEC exige un User-Agent identifiable ; Binance refuse les requêtes sans en-têtes de navigateur
export const HEADERS = { "user-agent": "Mozilla/5.0 trading-bot-jev (github.com/Spykoninho/trading-bot-jev)", clienttype: "web", lang: "en" };

const parser = new XMLParser({ ignoreAttributes: true, cdataPropName: "__cdata" });

const text = (v: unknown): string =>
  typeof v === "object" && v !== null && "__cdata" in v ? String((v as { __cdata: unknown }).__cdata) : String(v ?? "");

const MAX_BODY = 3000;

export const plain = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY);

// `withBody` : le flux porte le texte dans <description> (post Truth Social entier, résumé d'un communiqué SEC)
export function parseRss(xml: string, source: string, withBody = false): Headline[] {
  const items = parser.parse(xml)?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items])
    .map((item) => ({ title: text(item.title).trim(), source, publishedAt: new Date(text(item.pubDate)), link: text(item.link).trim(), body: withBody ? plain(text(item.description)) : "" }))
    // Posts sans texte (image ou vidéo seule) et dates illisibles : rien à juger
    .filter((h) => h.title && !h.title.startsWith("[No Title]") && !Number.isNaN(h.publishedAt.getTime()))
    .map(({ body, link, ...h }) => ({ ...h, publishedAt: h.publishedAt.toISOString(), ...(link ? { link } : {}), ...(body ? { body } : {}) }));
}

// Identité d'une publication : le titre seul ne suffit pas, la Fed réutilise « Federal Reserve issues FOMC statement »
export const headlineKey = (h: Headline) => `${h.title}|${h.publishedAt}`;

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

const rss = (name: string, kind: Source["kind"], url: string, everySec: number, withBody = false): Source => ({
  name,
  kind,
  everySec,
  fetch: async () => parseRss(await (await get(url)).text(), name, withBody),
});

// Le titre d'un communiqué de la Fed ne dit pas la décision : le texte est dans le bloc #article de la page
export async function fedBody(link: string): Promise<string> {
  const html = await (await get(new URL(link, "https://www.federalreserve.gov").href)).text();
  return plain(html.slice(Math.max(0, html.indexOf('id="article"'))));
}

// Annonces officielles Binance : catalogue 48 = nouveaux listings, 161 = retraits de cotation
export const BINANCE = { name: "Binance (annonces)", catalogs: [48, 161] };

export async function binanceAnnouncements(catalog: number, page = 1): Promise<Headline[]> {
  const res = await get(`https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=${page}&pageSize=50`);
  const body = (await res.json()) as { data?: { catalogs?: { articles?: { title: string; releaseDate: number }[] }[] } };
  return (body.data?.catalogs?.[0]?.articles ?? []).map((a) => ({ title: a.title, source: BINANCE.name, publishedAt: new Date(a.releaseDate).toISOString() }));
}

export const SOURCES: Source[] = [
  rss("CoinDesk", "presse", FEEDS.CoinDesk, 60),
  rss("Cointelegraph", "presse", FEEDS.Cointelegraph, 60),
  { name: BINANCE.name, kind: "primaire", everySec: 30, fetch: async () => (await Promise.all(BINANCE.catalogs.map((id) => binanceAnnouncements(id)))).flat() },
  rss("SEC (communiqués)", "primaire", "https://www.sec.gov/news/pressreleases.rss", 60, true),
  { ...rss("Fed (communiqués)", "primaire", "https://www.federalreserve.gov/feeds/press_all.xml", 30), fetchBody: (h) => fedBody(h.link ?? "") },
  rss("Trump (Truth Social)", "primaire", "https://trumpstruth.org/feed", 30, true),
];
