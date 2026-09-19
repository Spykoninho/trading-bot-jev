import { readFile, writeFile } from "node:fs/promises";
import type { Judgment } from "./brain.js";
import { config } from "./config.js";
import { isStrong, symbolFor } from "./events.js";
import { loadArchive } from "./history.js";
import { SOURCES } from "./news.js";

// Étude d'événements : le prix bouge-t-il dans le sens prédit par Jev APRÈS la parution d'un titre, ou avant ?
const CACHE = "data/event-klines.json";
const LATENCY_MIN = 2; // entrée réaliste : sondage RSS 60 s + jugement + ordre
// Le cache s'arrête à t0+240 min : après une entrée à +2, le dernier horizon mesurable est +238, pas les 4 h rondes
const HORIZONS = { "−60→0 (avant)": -60, "+5 min": 5, "+15 min": 15, "+1 h": 60, "+238 min": 238 };
const CONTROL = "Témoin (titres anodins)";
// Deux événements rapprochés sur le même actif et le même sens décrivent le même mouvement
const DEDUP_MIN = 30;

export type Prices = [number, number][];
export type Klines = Record<string, Prices>;
export type Stat = { n: number; mean: number; t: number; p: number };
export type Diff = { n: number; diff: number; t: number; p: number };
export type GroupResult = { group: string; n: number; horizons: Record<string, Stat>; net: Stat; vsControl: Record<string, Diff> };

// Le cache historique (data/event-klines.json) est libellé en marchés Binance USDT : on garde ces clés pour continuer à le lire hors ligne
const LEGACY_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const legacySymbolFor = (asset: string) => LEGACY_SYMBOLS.find((s) => s === `${asset === "crypto" ? "BTC" : asset}USDT`);

export const klineKey = (j: Judgment) => `${legacySymbolFor(j.asset)}:${j.headline.publishedAt}`;
// Les relevés récupérés depuis Bitvavo sont en euros : clé distincte pour ne jamais mélanger les deux devises
export const eurKlineKey = (j: Judgment) => `${symbolFor(j.asset)}:${j.headline.publishedAt}`;
const pricesFor = (klines: Klines, j: Judgment) => klines[klineKey(j)] ?? klines[eurKlineKey(j)];

// Loi normale centrée réduite (Abramowitz-Stegun 7.1.26) : suffisant pour un p bilatéral indicatif
function cdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - tail : tail;
}

export const pValue = (t: number) => Math.min(1, 2 * (1 - cdf(Math.abs(t))));

const variance = (values: number[], mean: number) => values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);

export function summarize(values: number[]): Stat {
  const n = values.length;
  if (n < 2) return { n, mean: n ? values[0]! : 0, t: 0, p: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const t = mean / Math.sqrt(variance(values, mean) / n) || 0;
  return { n, mean, t, p: pValue(t) };
}

// Écart au témoin : différence de moyennes et t de Welch (variances et effectifs inégaux)
export function welch(values: number[], control: number[]): Diff {
  if (values.length < 2 || control.length < 2) return { n: values.length, diff: 0, t: 0, p: 1 };
  const [mean, ctrl] = [values.reduce((a, b) => a + b, 0) / values.length, control.reduce((a, b) => a + b, 0) / control.length];
  const se = Math.sqrt(variance(values, mean) / values.length + variance(control, ctrl) / control.length);
  const t = (mean - ctrl) / se || 0;
  return { n: values.length, diff: mean - ctrl, t, p: pValue(t) };
}

// Sous-groupes par signal de source : attention, plus on en teste, plus un bon résultat peut être dû au hasard
export function groupsOf(judgments: Judgment[], kinds: Record<string, string>, minConfidence: number): Record<string, Judgment[]> {
  const relevant = judgments.filter((j) => j.asset !== "unrelated" && j.assetConfidence >= minConfidence);
  const strong = relevant.filter(isStrong);
  const strongOf = (k: string) => strong.filter((j) => kinds[j.headline.source] === k);
  // Les sous-groupes partent des signaux, pas du sentiment composé : mettre un effet à zéro ne doit pas les vider
  const from = (source: string, ...signals: string[]) =>
    relevant.filter((j) => j.headline.source.startsWith(source) && signals.reduce((sum, s) => sum + ((j.signals ?? {})[s] ?? 0), 0) >= 0.8);
  const dull = relevant.filter((j) => j.material < 0.3);
  // Témoin : autant de titres que Jev juge anodins, répartis sur toute la période
  const stride = Math.max(1, Math.floor(dull.length / Math.max(1, strong.length)));
  return {
    "Fort impact, presse": strongOf("presse"),
    "Fort impact, sources primaires": strongOf("primaire"),
    "Fed : baisses ou hausses de taux": from("Fed", "rate_cut", "rate_hike"),
    "SEC : portée industrie ou acteur majeur": from("SEC", "industry", "major_firm"),
    "Trump : escalade commerciale": from("Trump", "trade_escalation"),
    "Trump : escalade militaire": from("Trump", "military_escalation"),
    "Trump : soutien crypto": from("Trump", "crypto_support"),
    [CONTROL]: dull.filter((_, i) => i % stride === 0).slice(0, strong.length),
  };
}

function measure(group: string, list: Judgment[], klines: Klines, fee: number): { returns: Record<string, number[]>; net: number[] } {
  const returns: Record<string, number[]> = Object.fromEntries(Object.keys(HORIZONS).map((h) => [h, []]));
  const net: number[] = [];
  const last: Record<string, number> = {};
  let kept = 0;
  for (const j of list) {
    const t0 = Math.floor(Date.parse(j.headline.publishedAt) / 60_000) * 60_000;
    // Le témoin n'a pas de sens prédit : on alterne pour ne pas mesurer la seule dérive du marché
    const dir = group === CONTROL ? (kept % 2 ? -1 : 1) : Math.sign(j.sentiment) || 1;
    const key = `${symbolFor(j.asset)}:${dir}`;
    if (last[key] && t0 - last[key]! < DEDUP_MIN * 60_000) continue;
    const prices = pricesFor(klines, j);
    if (!prices) continue;
    const at = (min: number) => prices.find((p) => p[0] === t0 + min * 60_000)?.[1];
    const [published, entry] = [at(0), at(LATENCY_MIN)];
    if (!published || !entry) continue;
    last[key] = t0;
    kept++;
    for (const [label, min] of Object.entries(HORIZONS)) {
      const [from, to] = min < 0 ? [at(min), published] : [entry, at(LATENCY_MIN + min)];
      if (from && to) returns[label]!.push(dir * (to / from - 1));
    }
    const exit = at(LATENCY_MIN + 60);
    if (exit) net.push(dir * (exit / entry - 1) - 2 * fee);
  }
  return { returns, net };
}

// Pure : ne lit ni le réseau ni le disque, les bougies à la minute sont fournies par l'appelant
export function runStudy(judgments: Judgment[], klines: Klines, opts: { fee: number; minConfidence: number; kinds: Record<string, string> }): GroupResult[] {
  const measured = Object.entries(groupsOf(judgments, opts.kinds, opts.minConfidence)).map(([group, list]) => ({ group, ...measure(group, list, klines, opts.fee) }));
  const control = measured.find((m) => m.group === CONTROL);
  return measured.map((m) => ({
    group: m.group,
    n: m.net.length,
    horizons: Object.fromEntries(Object.entries(m.returns).map(([label, values]) => [label, summarize(values)])),
    net: summarize(m.net),
    vsControl: Object.fromEntries([
      ...Object.entries(m.returns).map(([label, values]) => [label, welch(values, control?.returns[label] ?? [])]),
      ["net", welch(m.net, control?.net ?? [])],
    ]),
  }));
}

const pct = (s: Stat) => (s.n < 3 ? `n=${s.n}` : `${(s.mean * 100).toFixed(3)} % (t=${s.t.toFixed(1)}, p=${s.p.toFixed(3)})`);
const gap = (d: Diff) => (d.n < 3 ? "—" : `${(d.diff * 100).toFixed(3)} pt (t=${d.t.toFixed(1)}, p=${d.p.toFixed(3)})`);

export function studyTable(results: GroupResult[]): Record<string, Record<string, string>> {
  return Object.fromEntries(
    results.map((r) => [
      `${r.group} (n=${r.n})`,
      { ...Object.fromEntries(Object.entries(r.horizons).map(([label, s]) => [label, pct(s)])), "suivre Jev 1 h, frais inclus": pct(r.net), "écart au témoin (1 h brut)": gap(r.vsControl["+1 h"]!) },
    ]),
  );
}

// Complète le cache pour les seuls événements absents : les anciens restent en USDT, les nouveaux arrivent de Bitvavo en euros
async function fillCache(cache: Klines, judgments: Judgment[]): Promise<void> {
  for (const j of judgments) {
    const market = symbolFor(j.asset);
    if (!market || cache[klineKey(j)] || cache[eurKlineKey(j)]) continue;
    const t0 = Math.floor(Date.parse(j.headline.publishedAt) / 60_000) * 60_000;
    const res = await fetch(`${config.bitvavo.rest}/${market}/candles?interval=1m&start=${t0 - 3_600_000}&end=${t0 + 240 * 60_000}&limit=1440`);
    if (!res.ok) throw new Error(`Bitvavo candles ${market} : HTTP ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string, string][];
    cache[eurKlineKey(j)] = rows.map((k) => [k[0], Number(k[4])] as [number, number]).sort((a, b) => a[0] - b[0]);
    await writeFile(CACHE, JSON.stringify(cache));
  }
}

if (process.argv[1]?.endsWith("event-study.ts")) {
  const { judgments } = await loadArchive();
  // Presse = article écrit après l'événement ; primaire = l'émetteur lui-même, horodaté à l'instant de l'événement
  const kinds = Object.fromEntries(SOURCES.map((s) => [s.name, s.kind]));
  const opts = { fee: config.fee, minConfidence: config.news.minConfidence, kinds };
  const cache: Klines = JSON.parse(await readFile(CACHE, "utf8").catch(() => "{}"));
  await fillCache(cache, Object.values(groupsOf(judgments, kinds, opts.minConfidence)).flat());
  console.log("Rendement moyen dans le sens prédit par Jev, autour de la parution du titre :");
  console.table(studyTable(runStudy(judgments, cache, opts)));
}
