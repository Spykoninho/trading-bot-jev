import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeHeadlines, judgeVersion, type Judgment } from "./brain.js";
import { config } from "./config.js";
import { FEEDS, HEADERS, fedBody, parseRss, plain, type Headline } from "./news.js";

// Archive des titres d'époque, avec les mêmes noms de sources que le direct
const FILE = "data/history.json";
const WAYBACK = "https://web.archive.org";
// Flux RSS sans archive propre : on passe par leurs captures de la Wayback Machine
const WAYBACK_FEEDS: Record<string, { url: string; withBody: boolean }> = {
  CoinDesk: { url: FEEDS.CoinDesk, withBody: false },
  Cointelegraph: { url: FEEDS.Cointelegraph, withBody: false },
  // Le site de la SEC refuse les robots, mais son flux contient le résumé de chaque communiqué
  "SEC (communiqués)": { url: "https://www.sec.gov/news/pressreleases.rss", withBody: true },
};
const FED_INDEX = "https://www.federalreserve.gov/json/ne-press.json";
const TRUMP_ARCHIVE = "https://ix.cnn.io/data/truth-social/truth_archive.json";
const BINANCE_CATALOGS = [48, 161];

type Archive = { captures: string[]; headlines: Headline[]; judgments: Judgment[] };

export async function loadArchive(): Promise<Archive> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Archive;
  } catch {
    return { captures: [], headlines: [], judgments: [] };
  }
}

async function save(archive: Archive): Promise<void> {
  await mkdir("data", { recursive: true });
  await writeFile(FILE, JSON.stringify(archive));
}

// Ajoute un titre, ou complète un titre déjà connu avec son texte et son lien
function upsert(archive: Archive, index: Map<string, Headline>, h: Headline, from: Date): void {
  if (!h.title || Date.parse(h.publishedAt) < from.getTime()) return;
  const known = index.get(h.title);
  if (known) return void Object.assign(known, { body: known.body ?? h.body, link: known.link ?? h.link });
  index.set(h.title, h);
  archive.headlines.push(h);
}

async function retry<T>(task: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await task();
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

// Une capture par jour et par flux (collapse=timestamp:8), sur la période du backtest
async function listCaptures(url: string, from: Date): Promise<string[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
  const query = `${WAYBACK}/cdx/search/cdx?url=${encodeURIComponent(url)}&from=${day(from)}&to=${day(new Date())}&output=json&filter=statuscode:200&collapse=timestamp:8&fl=timestamp`;
  const rows = await retry(async () => {
    const res = await fetch(query, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`CDX ${res.status}`);
    return (await res.json()) as string[][];
  });
  return rows.slice(1).map((r) => r[0]!);
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item);
  }));
}

async function collectHeadlines(archive: Archive, from: Date): Promise<void> {
  const index = new Map(archive.headlines.map((h) => [h.title, h]));
  for (const [source, { url: feedUrl, withBody }] of Object.entries(WAYBACK_FEEDS)) {
    // Des titres archivés sans leur texte : on retélécharge les captures de cette source pour le récupérer
    const incomplete = withBody && archive.headlines.some((h) => h.source === source && !h.body);
    const done = new Set(incomplete ? [] : archive.captures);
    // L'index de la Wayback Machine est parfois surchargé : on saute la source, elle sera reprise au prochain lancement
    const captures = await listCaptures(feedUrl.replace("https://", ""), from).catch((err: Error) => console.error(`${source} : index Wayback indisponible (${err.message})`));
    if (!captures) continue;
    const todo = captures.map((ts) => `${source}:${ts}`).filter((id) => !done.has(id));
    console.log(`${source} : ${todo.length} captures à télécharger`);
    let count = 0;
    await pool(todo, 4, async (id) => {
      const ts = id.split(":")[1];
      try {
        // Le suffixe id_ renvoie le XML d'origine, sans l'habillage de la Wayback Machine
        const xml = await retry(async () => {
          const res = await fetch(`${WAYBACK}/web/${ts}id_/${feedUrl}`, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) throw new Error(`capture ${res.status}`);
          return res.text();
        });
        for (const h of parseRss(xml, source, withBody)) upsert(archive, index, h, from);
        if (!archive.captures.includes(id)) archive.captures.push(id);
      } catch (err) {
        console.error(`capture ${id} ignorée : ${(err as Error).message}`);
      }
      if (++count % 50 === 0) {
        console.log(`  ${source} ${count}/${todo.length}, ${archive.headlines.length} titres`);
        await save(archive);
      }
    });
    await save(archive);
  }
}

// La Fed date ses communiqués en heure de New York, sans fuseau : on retrouve l'instant UTC
export function easternToIso(text: string): string {
  const asUtc = Date.parse(`${text} UTC`);
  const inNewYork = Date.parse(`${new Date(asUtc).toLocaleString("en-US", { timeZone: "America/New_York" })} UTC`);
  return new Date(asUtc + (asUtc - inNewYork)).toISOString();
}

async function getJson<T>(url: string): Promise<T> {
  return retry(async () => {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return JSON.parse((await res.text()).replace(/^\uFEFF/, "")) as T;
  });
}

// Sources primaires qui publient leur propre archive horodatée : Fed, posts de Trump, annonces Binance
async function collectPrimary(archive: Archive, from: Date): Promise<void> {
  const index = new Map(archive.headlines.map((h) => [h.title, h]));

  const fed = await getJson<{ d?: string; t?: string; l?: string }[]>(FED_INDEX);
  for (const item of fed) if (item.d && item.t) upsert(archive, index, { title: item.t.trim(), source: "Fed (communiqués)", publishedAt: easternToIso(item.d), link: item.l }, from);
  // Le titre d'un communiqué ne dit pas la décision : on va chercher le texte de chaque page
  const pages = archive.headlines.filter((h) => h.source === "Fed (communiqués)" && !h.body && h.link);
  console.log(`Fed : ${pages.length} pages à lire`);
  await pool(pages, 4, async (h) => {
    h.body = await retry(() => fedBody(h.link!)).catch(() => undefined);
  });

  // Titre = début du post (clé stable), body = post entier ; les posts image ou vidéo seuls sont ignorés
  const posts = await getJson<{ created_at: string; content?: string }[]>(TRUMP_ARCHIVE);
  for (const post of posts) {
    const body = plain(post.content ?? "");
    if (body.length > 20) upsert(archive, index, { title: body.slice(0, 400), source: "Trump (Truth Social)", publishedAt: new Date(post.created_at).toISOString(), body }, from);
  }

  for (const catalog of BINANCE_CATALOGS) {
    for (let page = 1; ; page++) {
      const body = await getJson<{ data?: { catalogs?: { articles?: { title: string; releaseDate: number }[] }[] } }>(
        `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=${page}&pageSize=50`,
      );
      const articles = body.data?.catalogs?.[0]?.articles ?? [];
      for (const a of articles) upsert(archive, index, { title: a.title, source: "Binance (annonces)", publishedAt: new Date(a.releaseDate).toISOString() }, from);
      if (!articles.length || articles.at(-1)!.releaseDate < from.getTime()) break;
    }
  }
  console.log(`Sources primaires : ${archive.headlines.length} titres au total`);
  await save(archive);
}

// Mêmes questions et même state que le direct. Un jugement est refait quand les questions de sa source ont changé de version.
async function judgeArchive(archive: Archive): Promise<void> {
  const current = new Map(archive.judgments.map((j) => [j.headline.title, j]));
  const todo = archive.headlines.filter((h) => (current.get(h.title)?.version ?? (current.has(h.title) ? 1 : 0)) < judgeVersion(h.source));
  console.log(`Jev : ${todo.length} titres à juger (${current.size - todo.filter((h) => current.has(h.title)).length} à jour)`);
  for (let i = 0; i < todo.length; i += 16) {
    try {
      for (const j of await judgeHeadlines(todo.slice(i, i + 16))) current.set(j.headline.title, j);
    } catch (err) {
      console.error(`lot ${i} ignoré, relancer pour le reprendre : ${(err as Error).message}`);
    }
    if (i % 800 === 0) {
      console.log(`  ${Math.min(i + 16, todo.length)}/${todo.length}`);
      archive.judgments = [...current.values()];
      await save(archive);
    }
  }
  archive.judgments = [...current.values()].sort((a, b) => a.headline.publishedAt.localeCompare(b.headline.publishedAt));
  await save(archive);
}

if (process.argv[1]?.endsWith("history.ts")) {
  const archive = await loadArchive();
  const from = new Date(Date.now() - config.backtestYears * 365 * 86_400_000);
  await collectPrimary(archive, from);
  await collectHeadlines(archive, from);
  if (!process.argv.includes("--no-judge")) await judgeArchive(archive);
  console.log(`Terminé : ${archive.headlines.length} titres, ${archive.judgments.length} jugements dans ${FILE}`);
}
