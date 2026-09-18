import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { placeMarketOrder } from "./broker.js";
import { config } from "./config.js";
import { startPriceFeed } from "./market.js";
import { fetchHeadlines } from "./news.js";
import { buy, close, equity, newPortfolio, recordEquity, stats, type Trade } from "./portfolio.js";
import { decide, type Decision } from "./strategy.js";

const STATE_FILE = "data/state.json";
const BUFFER_SEC = 600;
const MAX_JUDGMENTS = 60;

export const state = {
  portfolio: newPortfolio(config.startCash),
  judgments: [] as Judgment[],
  prices: {} as Record<string, number>,
  buffers: {} as Record<string, number[]>,
  signals: {} as Record<string, Decision>,
  lastExit: {} as Record<string, number>,
  speedMs: config.speeds.Normal,
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
  await writeFile(STATE_FILE, JSON.stringify({ portfolio: state.portfolio, judgments: state.judgments }));
}

// Miroir optionnel sur le testnet Binance ; un échec n'affecte jamais le portefeuille papier
function mirror(trade: Trade): void {
  if (!config.live) return;
  placeMarketOrder(trade.symbol, trade.side, trade.usdt * 0.98).catch((err: Error) => console.error(`testnet: ${err.message}`));
}

function act(d: Decision): void {
  if (d.action === "HOLD") return;
  const order = { symbol: d.symbol, price: d.price, fee: config.fee, reason: d.reason };
  const trade = d.action === "BUY" ? buy(state.portfolio, { ...order, usdt: config.orderUsdt }) : close(state.portfolio, order);
  if (!trade) return;
  if (trade.side === "SELL") state.lastExit[d.symbol] = Date.now();
  mirror(trade);
  emit("trade", trade);
  void persist();
}

// Boucle de décision : cadence réglable, 100 % code, Jev n'intervient que via le biais news
function decideAll(): void {
  for (const symbol of config.symbols) {
    const d = decide({
      symbol,
      prices: state.buffers[symbol] ?? [],
      judgments: state.judgments,
      position: state.portfolio.positions[symbol],
      lastExit: state.lastExit[symbol],
    });
    state.signals[symbol] = d;
    act(d);
  }
}

// Échantillonnage à la seconde : alimente les EMA et pousse l'état à l'interface
function sample(): void {
  for (const symbol of config.symbols) {
    const price = state.prices[symbol];
    if (!price) continue;
    const buffer = (state.buffers[symbol] ??= []);
    buffer.push(price);
    if (buffer.length > BUFFER_SEC) buffer.shift();
  }
  emit("tick", live());
}

// Jev ne juge que les titres jamais vus : chaque nouvelle news met à jour le biais en ~100 ms
async function refreshNews(): Promise<void> {
  const known = new Set(state.judgments.map((j) => j.headline.title));
  const fresh = (await fetchHeadlines()).filter((h) => !known.has(h.title));
  if (!fresh.length) return;
  const judged = await judgeHeadlines(fresh);
  state.judgments = [...judged, ...state.judgments]
    .sort((a, b) => b.headline.publishedAt.localeCompare(a.headline.publishedAt))
    .slice(0, MAX_JUDGMENTS);
  console.log(`Jev : ${judged.length} nouveau(x) titre(s) jugé(s)`);
  emit("news", state.judgments);
  await persist();
}

let decisionTimer: NodeJS.Timeout | undefined;

export function setSpeed(ms: number): void {
  state.speedMs = ms;
  clearInterval(decisionTimer);
  decisionTimer = ms > 0 ? setInterval(decideAll, ms) : undefined;
}

const safely = (task: () => Promise<unknown>) => task().catch((err) => console.error(err));

export async function start(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (saved.portfolio?.history && Array.isArray(saved.judgments)) Object.assign(state, saved);
  } catch {}

  startPriceFeed(config.symbols, (symbol, price) => {
    state.prices[symbol] = price;
    state.feedAt = Date.now();
  });
  setInterval(sample, 1000);
  setInterval(() => recordEquity(state.portfolio, state.prices), 5000);
  setInterval(() => safely(persist), 15_000);
  setInterval(() => safely(refreshNews), config.newsEverySec * 1000);
  setSpeed(state.speedMs);
  await safely(refreshNews);
}

export async function reset(): Promise<void> {
  state.portfolio = newPortfolio(config.startCash);
  state.lastExit = {};
  recordEquity(state.portfolio, state.prices);
  await persist();
  emit("reset", null);
}

// Instantané léger poussé chaque seconde
function live() {
  const p = state.portfolio;
  const total = equity(p, state.prices);
  return {
    time: Date.now(),
    feedOk: Date.now() - state.feedAt < 5000,
    speedMs: state.speedMs,
    prices: state.prices,
    signals: state.signals,
    equity: total,
    pnl: total - p.startCash,
    cash: p.cash,
    positions: Object.entries(p.positions).map(([symbol, pos]) => {
      const price = state.prices[symbol] ?? pos.entryPrice;
      return { symbol, ...pos, price, value: pos.qty * price, gain: price / pos.entryPrice - 1 };
    }),
    stats: stats(p),
  };
}

// État complet, chargé une fois à l'ouverture de la page puis après un reset
export function view() {
  const p = state.portfolio;
  return {
    config: { symbols: config.symbols, orderUsdt: config.orderUsdt, fee: config.fee, live: config.live, speeds: config.speeds, micro: config.micro, news: config.news },
    startedAt: p.startedAt,
    startCash: p.startCash,
    history: p.history,
    trades: p.trades,
    judgments: state.judgments,
    live: live(),
  };
}
