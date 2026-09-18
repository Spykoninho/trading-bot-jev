import { readFile, writeFile } from "node:fs/promises";
import type { Judgment } from "./brain.js";
import { config } from "./config.js";
import { loadArchive } from "./history.js";

// Étude d'événements : le prix bouge-t-il dans le sens prédit par Jev APRÈS la parution d'un titre, ou avant ?
const CACHE = "data/event-klines.json";
const LATENCY_MIN = 2; // entrée réaliste : sondage RSS 60 s + jugement + ordre
const HORIZONS = { "−60→0 (avant)": -60, "+5 min": 5, "+15 min": 15, "+1 h": 60, "+4 h": 237 };
const SYMBOL: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", crypto: "BTCUSDT" };

type Prices = [number, number][];

async function minutePrices(cache: Record<string, Prices>, j: Judgment): Promise<Prices> {
  const key = `${SYMBOL[j.asset]}:${j.headline.publishedAt}`;
  if (!cache[key]) {
    const start = Math.floor(Date.parse(j.headline.publishedAt) / 60_000) * 60_000 - 3_600_000;
    const res = await fetch(`${config.binance.data}/api/v3/klines?symbol=${SYMBOL[j.asset]}&interval=1m&startTime=${start}&limit=301`);
    if (!res.ok) throw new Error(`Binance klines: ${res.status}`);
    cache[key] = ((await res.json()) as [number, string, string, string, string][]).map((k) => [k[0], Number(k[4])]);
  }
  return cache[key]!;
}

function summarize(values: number[]) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return `${(mean * 100).toFixed(3)} % (t=${(mean / (sd / Math.sqrt(n))).toFixed(1)}, ${Math.round((values.filter((v) => v > 0).length / n) * 100)} % gagnants)`;
}

const { judgments } = await loadArchive();
const relevant = judgments.filter((j) => j.asset !== "unrelated" && j.assetConfidence >= config.news.minConfidence);
const strong = relevant.filter((j) => j.material >= 0.7 && Math.abs(j.sentiment) >= 0.5);
const dull = relevant.filter((j) => j.material < 0.3);
// Témoin : autant de titres que Jev juge anodins, répartis sur toute la période
const control = dull.filter((_, i) => i % Math.floor(dull.length / strong.length) === 0).slice(0, strong.length);

const cache: Record<string, Prices> = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
const table: Record<string, Record<string, string>> = {};

for (const [group, events] of Object.entries({ "Fort impact selon Jev": strong, "Témoin (titres anodins)": control })) {
  const returns: Record<string, number[]> = Object.fromEntries(Object.keys(HORIZONS).map((h) => [h, []]));
  const net: number[] = [];
  const last: Record<string, number> = {};
  for (const j of events) {
    const t0 = Math.floor(Date.parse(j.headline.publishedAt) / 60_000) * 60_000;
    const dir = Math.sign(j.sentiment) || 1;
    // Un même événement génère plusieurs titres : on garde le premier par actif et par sens sur 30 min
    const key = `${SYMBOL[j.asset]}:${dir}`;
    if (last[key] && t0 - last[key]! < 30 * 60_000) continue;
    last[key] = t0;
    const prices = await minutePrices(cache, j);
    const at = (min: number) => prices.find((p) => p[0] === t0 + min * 60_000)?.[1];
    const [published, entry] = [at(0), at(LATENCY_MIN)];
    if (!published || !entry) continue;
    for (const [label, min] of Object.entries(HORIZONS)) {
      const [from, to] = min < 0 ? [at(min), published] : [entry, at(LATENCY_MIN + min)];
      if (from && to) returns[label]!.push(dir * (to / from - 1));
    }
    const exit = at(LATENCY_MIN + 60);
    if (exit) net.push(dir * (exit / entry - 1) - 2 * config.fee);
  }
  table[`${group} (n=${net.length})`] = { ...Object.fromEntries(Object.entries(returns).map(([h, v]) => [h, summarize(v)])), "suivre Jev 1 h, frais inclus": summarize(net) };
  await writeFile(CACHE, JSON.stringify(cache));
}

console.log("Rendement moyen dans le sens prédit par Jev, autour de la parution du titre :");
console.table(table);
