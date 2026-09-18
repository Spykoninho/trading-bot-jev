import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { config } from "./config.js";
import { FEEDS, parseRss, type Headline } from "./news.js";

// Archive des titres d'époque : la Wayback Machine conserve des captures des mêmes flux RSS que le direct
const FILE = "data/history.json";
const WAYBACK = "https://web.archive.org";

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
  for (const [source, feedUrl] of Object.entries(FEEDS)) {
    const url = feedUrl.replace("https://", "");
    const todo = (await listCaptures(url, from)).map((ts) => `${source}:${ts}`).filter((id) => !done.has(id));
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
  await collectHeadlines(archive, new Date(Date.now() - config.backtestYears * 365 * 86_400_000));
  if (!process.argv.includes("--no-judge")) await judgeArchive(archive);
  console.log(`Terminé : ${archive.headlines.length} titres, ${archive.judgments.length} jugements dans ${FILE}`);
}
