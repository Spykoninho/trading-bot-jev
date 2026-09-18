import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { config } from "./config.js";
import { FEEDS, HEADERS, parseRss, type Headline } from "./news.js";

// Archive des titres d'époque, avec les mêmes noms de sources que le direct
const FILE = "data/history.json";
const WAYBACK = "https://web.archive.org";
// Flux RSS sans archive propre : on passe par leurs captures de la Wayback Machine
const WAYBACK_FEEDS = { ...FEEDS, "SEC (communiqués)": "https://www.sec.gov/news/pressreleases.rss" };
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
  const seen = new Set(archive.headlines.map((h) => h.title));
  const done = new Set(archive.captures);
  for (const [source, feedUrl] of Object.entries(WAYBACK_FEEDS)) {
    const url = feedUrl.replace("https://", "");
    // L'index de la Wayback Machine est parfois surchargé : on saute la source, elle sera reprise au prochain lancement
    const captures = await listCaptures(url, from).catch((err: Error) => console.error(`${source} : index Wayback indisponible (${err.message})`));
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
        for (const h of parseRss(xml, source)) {
          if (seen.has(h.title) || Date.parse(h.publishedAt) < from.getTime()) continue;
          seen.add(h.title);
          archive.headlines.push(h);
        }
        archive.captures.push(id);
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
  const seen = new Set(archive.headlines.map((h) => h.title));
  const add = (title: string, source: string, publishedAt: string) => {
    if (!title || seen.has(title) || Date.parse(publishedAt) < from.getTime()) return;
    seen.add(title);
    archive.headlines.push({ title, source, publishedAt });
  };

  const fed = await getJson<{ d?: string; t?: string }[]>(FED_INDEX);
  for (const item of fed) if (item.d && item.t) add(item.t.trim(), "Fed (communiqués)", easternToIso(item.d));

  // Posts réduits à leur texte, tronqué comme un titre : les posts image ou vidéo seuls sont ignorés
  const posts = await getJson<{ created_at: string; content?: string }[]>(TRUMP_ARCHIVE);
  for (const post of posts) {
    const body = (post.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (body.length > 20) add(body.slice(0, 400), "Trump (Truth Social)", new Date(post.created_at).toISOString());
  }

  for (const catalog of BINANCE_CATALOGS) {
    for (let page = 1; ; page++) {
      const body = await getJson<{ data?: { catalogs?: { articles?: { title: string; releaseDate: number }[] }[] } }>(
        `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalog}&pageNo=${page}&pageSize=50`,
      );
      const articles = body.data?.catalogs?.[0]?.articles ?? [];
      for (const a of articles) add(a.title, "Binance (annonces)", new Date(a.releaseDate).toISOString());
      if (!articles.length || articles.at(-1)!.releaseDate < from.getTime()) break;
    }
  }
  console.log(`Sources primaires : ${archive.headlines.length} titres au total`);
  await save(archive);
}

// Mêmes questions et même state que le direct : un titre par requête, jamais rejugé
async function judgeArchive(archive: Archive): Promise<void> {
  const judged = new Set(archive.judgments.map((j) => j.headline.title));
  const todo = archive.headlines.filter((h) => !judged.has(h.title));
  console.log(`Jev : ${todo.length} titres à juger (${judged.size} déjà faits)`);
  for (let i = 0; i < todo.length; i += 16) {
    try {
      archive.judgments.push(...(await judgeHeadlines(todo.slice(i, i + 16))));
    } catch (err) {
      console.error(`lot ${i} ignoré, relancer pour le reprendre : ${(err as Error).message}`);
    }
    if (i % 800 === 0) {
      console.log(`  ${Math.min(i + 16, todo.length)}/${todo.length}`);
      await save(archive);
    }
  }
  archive.judgments.sort((a, b) => a.headline.publishedAt.localeCompare(b.headline.publishedAt));
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
