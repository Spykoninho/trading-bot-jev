import { mkdir, readFile, writeFile } from "node:fs/promises";
import { backtest, type BacktestResult } from "./backtest.js";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { placeMarketOrder } from "./broker.js";
import { config } from "./config.js";
import { loadArchive } from "./history.js";
import { fetchCandles, fetchHistory, startPriceFeed } from "./market.js";
import { dueReadings, matchRule, scoreboard, track, type TrackedEvent } from "./events.js";
import { SOURCES, headlineKey, type Source } from "./news.js";
import { buy, close, equity, newPortfolio, recordEquity, stats, type Trade } from "./portfolio.js";
import { decide, type Decision } from "./strategy.js";

const STATE_FILE = "data/state.json";
const EVENTS_FILE = "data/events.json";
const MAX_JUDGMENTS = 100;
const MAX_SEEN = 3000;
const MAX_EVENTS = 5000;

export const state = {
  portfolio: newPortfolio(config.startCash),
  // Actifs sur lesquels cette simulation investit, choisis à son lancement
  active: [...config.symbols],
  judgments: [] as Judgment[],
  // Publications déjà jugées (titre + date de parution), toutes sources confondues : jamais rejugées ni recomptées
  seen: [] as string[],
  events: [] as TrackedEvent[],
  prices: {} as Record<string, number>,
  closes: {} as Record<string, number[]>,
  signals: {} as Record<string, Decision>,
  feedAt: 0,
};

// Bus d'événements minimal : le serveur y abonne chaque client SSE
type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
const emit: Listener = (event, data) => listeners.forEach((fn) => fn(event, data));

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function persist(): Promise<void> {
  await mkdir("data", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ portfolio: state.portfolio, active: state.active, judgments: state.judgments, seen: state.seen }));
  await writeFile(EVENTS_FILE, JSON.stringify(state.events));
}

// Miroir optionnel sur le testnet Binance ; un échec n'affecte jamais le portefeuille papier
function mirror(trade: Trade): void {
  if (!config.live) return;
  placeMarketOrder(trade.symbol, trade.side, trade.usdt * 0.98).catch((err: Error) => console.error(`testnet: ${err.message}`));
}

function act(d: Decision): void {
  if (d.action === "HOLD") return;
  // Exécution au prix temps réel ; hors réserve événementielle, le capital est réparti à parts égales entre les actifs choisis
  const order = { symbol: d.symbol, price: state.prices[d.symbol] ?? d.price, fee: config.fee, reason: d.reason };
  const usdt = (equity(state.portfolio, state.prices) * (1 - config.eventReserve)) / state.active.length;
  announce(d.action === "BUY" ? buy(state.portfolio, { ...order, usdt }) : close(state.portfolio, order));
}

function announce(trade: Trade | null): void {
  if (!trade) return;
  console.log(`${trade.side} ${trade.symbol} ${trade.usdt.toFixed(2)} USDT @ ${trade.price} — ${trade.reason}`);
  mirror(trade);
  emit("trade", trade);
}

// Circuit immédiat : n'attend pas la clôture d'une bougie 4 h, agit dès qu'un événement capté en direct déclenche une règle
function react(event: TrackedEvent): void {
  const rule = matchRule(event, config.eventRules);
  if (!rule || !state.active.includes(event.symbol)) return;
  const order = { symbol: event.symbol, book: "event" as const, price: state.prices[event.symbol]!, fee: config.fee, reason: `événement : ${rule.name}` };
  const exitAt = new Date(Date.now() + rule.holdMin * 60_000).toISOString();
  announce(buy(state.portfolio, { ...order, usdt: equity(state.portfolio, state.prices) * rule.share, exitAt }));
}

function closeExpired(): void {
  for (const pos of Object.values(state.portfolio.positions)) {
    if (!pos.exitAt || Date.parse(pos.exitAt) > Date.now()) continue;
    announce(close(state.portfolio, { symbol: pos.symbol, book: "event", price: state.prices[pos.symbol] ?? pos.entryPrice, fee: config.fee, reason: "événement : sortie programmée" }));
  }
}

// Décision 100 % code sur les bougies clôturées ; Jev n'intervient que via le biais et le veto news
function decideAll(): void {
  for (const symbol of config.symbols) {
    const closes = state.closes[symbol];
    if (!closes) continue;
    const d = decide({ symbol, closes, judgments: state.judgments, position: state.portfolio.positions[symbol] });
    // La tendance est calculée pour tous les actifs, mais le bot n'agit que sur ceux de la simulation
    state.signals[symbol] = d;
    if (state.active.includes(symbol)) act(d);
  }
}

async function refreshCandles(): Promise<void> {
  const { interval, window } = config.strategy;
  await Promise.all(
    config.symbols.map(async (symbol) => {
      const candles = await fetchCandles(symbol, interval, window);
      // La dernière bougie renvoyée est encore en cours : on ne décide que sur des clôtures
      state.closes[symbol] = candles.slice(0, -1).map((c) => c.close);
      state.prices[symbol] ??= candles.at(-1)!.close;
    }),
  );
  decideAll();
}

// Jev ne juge que les titres jamais vus : chaque nouveauté met à jour le biais news et ouvre un événement suivi
async function pollSource(source: Source): Promise<void> {
  const known = new Set(state.seen);
  const fresh = (await source.fetch()).filter((h) => !known.has(headlineKey(h)));
  if (!fresh.length) return;
  state.seen = [...state.seen, ...fresh.map(headlineKey)].slice(-MAX_SEEN);
  // Texte complet récupéré pour les seuls titres nouveaux ; en cas d'échec, Jev juge le titre
  if (source.fetchBody) for (const h of fresh) h.body = await source.fetchBody(h).catch(() => undefined);
  const judged = await judgeHeadlines(fresh);
  state.judgments = [...judged, ...state.judgments]
    .sort((a, b) => b.headline.publishedAt.localeCompare(a.headline.publishedAt))
    .slice(0, MAX_JUDGMENTS);

  const tracked = judged.map((j) => track(j, source.kind, state.prices, config.news.minConfidence)).filter((e) => e !== null);
  state.events = [...state.events, ...tracked].slice(-MAX_EVENTS);
  tracked.forEach(react);
  console.log(`${source.name} : ${judged.length} nouveau(x) titre(s) jugé(s), ${tracked.length} suivi(s)`);
  emit("news", state.judgments);
  if (tracked.length) emit("events", eventsView());
  decideAll();
}

// Relevé des prix à échéance (+5 min, +15 min, +1 h, +4 h) : on lit la bougie 1 min clôturée, même après un redémarrage
async function fillReadings(): Promise<void> {
  const due = dueReadings(state.events);
  for (const { event, horizon, at } of due) {
    const [candle] = await fetchCandles(event.symbol, "1m", 1, Math.floor(at / 60_000) * 60_000);
    if (candle) event.after[horizon] = candle.close;
  }
  if (due.length) emit("events", eventsView());
}

const safely = (task: () => Promise<unknown>) => task().catch((err) => console.error(err));

export async function start(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    const positions = Object.values(saved.portfolio?.positions ?? {}) as { cost?: number }[];
    const active = (saved.active ?? []).filter((s: string) => config.symbols.includes(s));
    if (active.length && positions.every((p) => p.cost !== undefined)) Object.assign(state, { ...saved, active, seen: saved.seen ?? [] });
    // Positions sauvegardées avant l'ajout du champ `symbol` : la clé était le symbole
    for (const [key, pos] of Object.entries(state.portfolio.positions)) pos.symbol ??= key;
  } catch {}
  try {
    state.events = JSON.parse(await readFile(EVENTS_FILE, "utf8"));
  } catch {}

  startPriceFeed(config.symbols, (symbol, price) => {
    state.prices[symbol] = price;
    state.feedAt = Date.now();
  });
  setInterval(() => emit("tick", live()), 1000);
  setInterval(() => recordEquity(state.portfolio, state.prices), 5000);
  setInterval(() => safely(persist), 15_000);
  setInterval(() => safely(refreshCandles), config.candlesEverySec * 1000);
  setInterval(() => safely(fillReadings), 60_000);
  setInterval(closeExpired, 10_000);

  await safely(refreshCandles);
  // Chaque source a sa cadence : la presse toutes les 60 s, les sources primaires toutes les 30 s
  for (const source of SOURCES) {
    await safely(() => pollSource(source));
    setInterval(() => safely(() => pollSource(source)), source.everySec * 1000);
  }
  await safely(fillReadings);
}

// Nouvelle simulation : l'utilisateur choisit les actifs, le bot s'aligne aussitôt sur leur tendance
export async function reset(symbols: string[]): Promise<void> {
  const active = config.symbols.filter((s) => symbols.includes(s));
  if (!active.length) throw new Error("Choisis au moins un actif.");
  state.active = active;
  state.portfolio = newPortfolio(config.startCash);
  recordEquity(state.portfolio, state.prices);
  decideAll();
  await persist();
  emit("reset", null);
}

// Backtest sur l'historique réel, mis en cache une heure ; même fonction `decide` que le live
const variant = (r: BacktestResult) => ({ curve: r.strategy, trades: r.trades, stats: r.stats });
type Comparison = Awaited<ReturnType<typeof compare>>;
const cache = new Map<string, { at: number; result: Comparison }>();

// Deux passes sur les mêmes bougies : sans news, puis avec les titres d'époque jugés par Jev (npm run history)
async function compare(symbols: string[]) {
  const entries = await Promise.all(symbols.map(async (s) => [s, await fetchHistory(s, config.strategy.interval, config.backtestYears)] as const));
  const history = Object.fromEntries(entries);
  const { judgments } = await loadArchive();
  const plain = backtest(history);
  const jev = judgments.length ? backtest(history, config, judgments) : null;
  const first = new Date(plain.times[0]!).toISOString();
  const covered = new Set(judgments.filter((j) => j.headline.publishedAt >= first).map((j) => j.headline.publishedAt.slice(0, 10)));
  return {
    symbols,
    times: plain.times,
    hold: plain.hold,
    holdStats: { return: plain.stats.holdReturn, drawdown: plain.stats.holdDrawdown },
    plain: variant(plain),
    jev: jev && variant(jev),
    news: { headlines: judgments.length, daysCovered: covered.size, days: Math.round((plain.times.at(-1)! - plain.times[0]!) / 86_400_000) + 1 },
  };
}

export async function runBacktest(): Promise<Comparison> {
  const symbols = [...state.active];
  const hit = cache.get(symbols.join());
  if (hit && Date.now() - hit.at < 3_600_000) return hit.result;
  const result = await compare(symbols);
  cache.set(symbols.join(), { at: Date.now(), result });
  return result;
}

function eventsView() {
  return { list: state.events.slice(-300).reverse(), scoreboard: scoreboard(state.events), sources: SOURCES.map((s) => ({ name: s.name, kind: s.kind, everySec: s.everySec })) };
}

// Instantané léger poussé chaque seconde
function live() {
  const p = state.portfolio;
  const total = equity(p, state.prices);
  return {
    time: Date.now(),
    feedOk: Date.now() - state.feedAt < 5000,
    prices: state.prices,
    signals: state.signals,
    equity: total,
    pnl: total - p.startCash,
    cash: p.cash,
    positions: Object.entries(p.positions).map(([key, pos]) => {
      const price = state.prices[pos.symbol] ?? pos.entryPrice;
      return { ...pos, event: key !== pos.symbol, price, value: pos.qty * price, gain: price / pos.entryPrice - 1 };
    }),
    stats: stats(p),
  };
}

// État complet, chargé une fois à l'ouverture de la page puis après un reset
export function view() {
  const p = state.portfolio;
  return {
    config: { symbols: config.symbols, fee: config.fee, live: config.live, strategy: config.strategy, news: config.news, eventRules: config.eventRules, backtestYears: config.backtestYears },
    active: state.active,
    startedAt: p.startedAt,
    startCash: p.startCash,
    history: p.history,
    trades: p.trades,
    judgments: state.judgments,
    events: eventsView(),
    live: live(),
  };
}
