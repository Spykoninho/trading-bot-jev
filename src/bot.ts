import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { backtest, type BacktestResult } from "./backtest.js";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { accountBalances, marketBuy, marketSell, SellIncompleteError, symbolFilters } from "./broker.js";
import { config } from "./config.js";
import { loadArchive } from "./history.js";
import { fetchCandleAt, fetchCandles, fetchHistory, startPriceFeed } from "./market.js";
import { dueReadings, matchRule, scoreboard, track, type TrackedEvent } from "./events.js";
import { SOURCES, headlineKey, type Source } from "./news.js";
import { buy, close, equity, holdValue, MIN_NOTIONAL, newPortfolio, recordEquity, startHold, stats, totalsFrom, type Position, type Trade } from "./portfolio.js";
import { baseOf, decide, type Decision } from "./strategy.js";

const STATE_FILE = "data/state.json";
const EVENTS_FILE = "data/events.json";
const MAX_SEEN = 3000;
const MAX_EVENTS = 5000;
const MAX_WAITS = 300;
// Au-delà, le prix en direct n'est plus fiable : aucun ordre n'est exécuté
const STALE_FEED_MS = 30_000;
// Premier passage sur une source : seuls les titres les plus récents sont jugés, le reste du flux est marqué comme vu
const FIRST_PASS_JUDGED = 10;

export const state = {
  portfolio: newPortfolio(config.startCash),
  // Actifs sur lesquels cette simulation investit, choisis à son lancement
  active: [...config.symbols],
  judgments: [] as Judgment[],
  // Publications déjà jugées (titre + date de parution), toutes sources confondues : jamais rejugées ni recomptées
  seen: [] as string[],
  events: [] as TrackedEvent[],
  // « Attendre » est aussi une décision : une entrée par actif à chaque clôture de bougie sans ordre, et tout ordre refusé
  waits: [] as { time: string; symbol: string; price: number; reason: string }[],
  lastCandle: {} as Record<string, number>,
  prices: {} as Record<string, number>,
  closes: {} as Record<string, number[]>,
  signals: {} as Record<string, Decision>,
  // Symboles dont les bougies ne se chargent plus, avec la raison : le bot continue sans eux
  unavailable: {} as Record<string, string>,
  // Portefeuille papier et compte Bitvavo ne correspondent plus : à traiter à la main
  desynced: null as string | null,
  // Journal des erreurs et avertissements montré dans l'interface
  alerts: [] as Alert[],
  feedAt: 0,
};

export type Alert = { id: number; time: number; level: "error" | "warn" | "info"; message: string };

const MAX_ALERTS = 100;
// Anti-répétition : un même message n'est journalisé qu'une fois par tranche de 10 min
export const ALERT_REPEAT_MS = 600_000;

// Pure : décide si ce message doit être journalisé maintenant, et note son passage
export function shouldAlert(seen: Map<string, number>, message: string, now: number, everyMs = ALERT_REPEAT_MS): boolean {
  if (now - (seen.get(message) ?? -Infinity) < everyMs) return false;
  seen.set(message, now);
  return true;
}

const alertSeen = new Map<string, number>();
let alertId = 0;

// Toute erreur ou anomalie passe par ici : l'interface lit `alerts` dans view()
export function alert(level: Alert["level"], message: string, now = Date.now()): void {
  if (!shouldAlert(alertSeen, message, now)) return;
  state.alerts = [...state.alerts, { id: ++alertId, time: now, level, message }].slice(-MAX_ALERTS);
  (level === "error" ? console.error : console.warn)(message);
  emit("alerts", state.alerts);
}

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
  const { portfolio, active, judgments, seen, waits, lastCandle } = state;
  // `quote` sert de marqueur de devise : un état écrit dans une autre devise est archivé au chargement
  await writeFile(STATE_FILE, JSON.stringify({ quote: config.quote, portfolio, active, judgments, seen, waits, lastCandle }));
  await writeFile(EVENTS_FILE, JSON.stringify(state.events));
}

// Le drapeau part avec l'instantané poussé chaque seconde : l'interface l'affiche en évidence
function desync(message: string): void {
  state.desynced = message;
  alert("error", `Désynchronisation entre le portefeuille du bot et le compte Bitvavo : ${message}`);
}

const reported: Record<string, number> = {};

// Journal visible dans l'interface ; un même motif n'y est répété qu'une fois par minute
function logWait(symbol: string, price: number, reason: string, key = reason): void {
  if (Date.now() - (reported[`${symbol}|${key}`] ?? 0) < 60_000) return;
  reported[`${symbol}|${key}`] = Date.now();
  alert("warn", `${symbol} : ${reason}`);
  state.waits = [...state.waits, { time: new Date().toISOString(), symbol, price, reason }].slice(-MAX_WAITS);
  emit("waits", state.waits);
}

// Prix d'exécution : jamais le dernier prix connu ni une clôture de bougie, uniquement un flux temps réel frais
function executionPrice(symbol: string): number | null {
  if (Date.now() - state.feedAt > STALE_FEED_MS) return null;
  return state.prices[symbol] ?? null;
}

// Identifiant stable dérivé de l'ordre papier : rejouer le même ordre ne le duplique pas chez Bitvavo
const orderId = (trade: Trade) => `jev-${trade.side === "BUY" ? "b" : "s"}-${trade.symbol}-${Date.parse(trade.time).toString(36)}`.slice(0, 36);

// Réplique l'ordre papier sur l'exchange ; on retient la quantité réellement achetée pour revendre exactement celle-là
function mirror(trade: Trade, position?: Position): void {
  if (!config.exchange) return;
  const id = orderId(trade);
  if (trade.side === "BUY") {
    marketBuy(trade.symbol, trade.usdt, id).then(
      (qty) => position && (position.exchangeQty = qty),
      (err: Error) => desync(`achat ${trade.symbol} non passé sur Bitvavo (${err.message}) : le bot compte une position que le compte ne détient pas`),
    );
    return;
  }
  if (!trade.exchangeQty) return void desync(`vente ${trade.symbol} sans quantité connue sur Bitvavo : la position n'y avait pas été achetée`);
  marketSell(trade.symbol, trade.exchangeQty, trade.price, id).catch((err: Error) => {
    // Vente partielle : le reliquat reste détenu sur le compte, on le garde attaché à l'ordre
    if (err instanceof SellIncompleteError) {
      trade.exchangeQty = err.result.remaining;
      return desync(`vente ${trade.symbol} partiellement exécutée sur Bitvavo : ${err.result.executedQty} vendus, ${err.result.remaining} encore détenus`);
    }
    desync(`vente ${trade.symbol} non exécutée sur Bitvavo (${err.message})`);
  });
}

function act(decision: Decision): void {
  if (decision.action === "HOLD") return;
  const price = executionPrice(decision.symbol);
  if (price === null) return logWait(decision.symbol, decision.price, "ordre reporté à la passe suivante : flux de prix périmé", "flux");

  const total = equity(state.portfolio, state.prices);
  const order = { symbol: decision.symbol, price, fee: config.fee, slippageBps: config.slippageBps, reason: decision.reason };
  // Hors réserve événementielle, le capital est réparti à parts égales entre les actifs de la simulation
  const usdt = (total * (1 - config.eventReserve)) / state.active.length;
  const floor = total * config.eventReserve;
  const trade = decision.action === "BUY" ? buy(state.portfolio, { ...order, usdt, floor }) : close(state.portfolio, order);
  if (trade) return announce(trade);

  const free = state.portfolio.cash - floor;
  const why =
    decision.action === "SELL"
      ? "vente refusée : aucune position de tendance ouverte"
      : state.portfolio.positions[decision.symbol]
        ? "achat refusé : déjà en position sur cet actif"
        : `achat refusé : ${usdt.toFixed(2)} ${config.quote} demandés, ${free.toFixed(2)} disponibles hors réserve, minimum ${MIN_NOTIONAL}`;
  logWait(decision.symbol, price, why, "refus");
}

function announce(trade: Trade): void {
  console.log(`${trade.side} ${trade.symbol} ${trade.usdt.toFixed(2)} ${config.quote} @ ${trade.price} — ${trade.reason}`);
  mirror(trade, Object.values(state.portfolio.positions).find((pos) => pos.entryTime === trade.time));
  emit("trade", trade);
}

// Circuit immédiat : n'attend pas la clôture d'une bougie 4 h, agit dès qu'un événement capté en direct déclenche une règle
function react(event: TrackedEvent): void {
  const rule = matchRule(event, config.eventRules);
  if (!rule || !state.active.includes(event.symbol)) return;
  const price = executionPrice(event.symbol);
  if (price === null) return logWait(event.symbol, event.priceAtSeen, `événement « ${rule.name} » ignoré : flux de prix périmé`, "flux");

  const reason = `événement : ${rule.name}`;
  const order = { symbol: event.symbol, book: "event" as const, price, fee: config.fee, slippageBps: config.slippageBps, reason };
  const exitAt = new Date(Date.now() + rule.holdMin * 60_000).toISOString();
  // La poche événementielle puise dans la réserve : pas de plancher de cash ici
  const usdt = equity(state.portfolio, state.prices) * rule.share;
  const trade = buy(state.portfolio, { ...order, usdt, exitAt });
  if (trade) return announce(trade);
  logWait(event.symbol, price, `${reason} non exécuté : ${usdt.toFixed(2)} ${config.quote} demandés, ${state.portfolio.cash.toFixed(2)} en caisse, minimum ${MIN_NOTIONAL}`, "refus-event");
}

function closeExpired(): void {
  for (const pos of Object.values(state.portfolio.positions)) {
    if (!pos.exitAt || Date.parse(pos.exitAt) > Date.now()) continue;
    const price = executionPrice(pos.symbol);
    if (price === null) {
      logWait(pos.symbol, pos.entryPrice, "sortie d'événement reportée : flux de prix périmé", "flux");
      continue;
    }
    const trade = close(state.portfolio, { symbol: pos.symbol, book: "event", price, fee: config.fee, slippageBps: config.slippageBps, reason: "événement : sortie programmée" });
    if (trade) announce(trade);
  }
}

// Décision 100 % code sur les bougies clôturées ; Jev n'intervient que via le biais et le veto news
function decideAll(journal = false): void {
  for (const symbol of config.symbols) {
    const closes = state.closes[symbol];
    if (!closes || state.unavailable[symbol]) continue;
    const decision = decide({ symbol, closes, judgments: state.judgments, position: state.portfolio.positions[symbol] });
    // La tendance est calculée pour tous les actifs, mais le bot n'agit que sur ceux de la simulation
    state.signals[symbol] = decision;
    if (!state.active.includes(symbol)) continue;
    act(decision);
    if (journal && decision.action === "HOLD") state.waits = [...state.waits, { time: new Date().toISOString(), symbol, price: state.prices[symbol] ?? decision.price, reason: decision.reason }].slice(-MAX_WAITS);
  }
  if (journal) emit("waits", state.waits);
}

async function refreshCandles(): Promise<void> {
  const { interval, window } = config.strategy;
  const results = await Promise.allSettled(
    config.symbols.map(async (symbol) => {
      const candles = await fetchCandles(symbol, interval, window);
      // La dernière bougie renvoyée est encore en cours : on ne décide que sur des clôtures
      state.closes[symbol] = candles.slice(0, -1).map((c) => c.close);
      state.prices[symbol] ??= candles.at(-1)!.close;
      const closedAt = candles.at(-2)!.time;
      delete state.unavailable[symbol];
      if (state.lastCandle[symbol] === closedAt) return false;
      state.lastCandle[symbol] = closedAt;
      return true;
    }),
  );
  // Un symbole en panne est signalé à l'interface et mis de côté : il ne gèle pas les décisions des autres
  results.forEach((result, i) => {
    if (result.status !== "rejected") return;
    const symbol = config.symbols[i]!;
    state.unavailable[symbol] = (result.reason as Error)?.message ?? String(result.reason);
    alert("error", `${symbol} indisponible : les cours ne se chargent plus (${state.unavailable[symbol]})`);
  });
  // Une nouvelle bougie vient de clôturer : la décision de chaque actif est consignée, ordre ou attente
  decideAll(results.some((result) => result.status === "fulfilled" && result.value));
}

// Une seule entrée par publication, les plus récentes d'abord, sur la fenêtre glissante utilisée aussi par le backtest
export const latest = (judgments: Judgment[], now = Date.now()): Judgment[] =>
  [...new Map(judgments.map((j) => [headlineKey(j.headline), j])).values()]
    .filter((j) => Date.parse(j.headline.publishedAt) >= now - config.news.windowMs)
    .sort((a, b) => b.headline.publishedAt.localeCompare(a.headline.publishedAt))
    .slice(0, config.news.maxKept);

const byDateDesc = (a: { publishedAt: string }, b: { publishedAt: string }) => b.publishedAt.localeCompare(a.publishedAt);

// Jev ne juge que les titres jamais vus : chaque nouveauté met à jour le biais news et ouvre un événement suivi
async function pollSource(source: Source): Promise<void> {
  const known = new Set(state.seen);
  const all = await source.fetch().catch((err: Error) => {
    alert("warn", `Source d'actualités « ${source.name} » injoignable : ${err.message}`);
    return [];
  });
  const fresh = all.filter((h) => !known.has(headlineKey(h))).sort(byDateDesc);
  if (!fresh.length) return;
  // Premier passage sur cette source : le flux entier est neuf, on ne juge que les titres récents et on classe le reste
  const firstPass = !all.some((h) => known.has(headlineKey(h)));
  const todo = firstPass ? fresh.slice(0, FIRST_PASS_JUDGED) : fresh;
  const skipped = firstPass ? fresh.slice(FIRST_PASS_JUDGED) : [];
  if (skipped.length) state.seen = [...state.seen, ...skipped.map(headlineKey)].slice(-MAX_SEEN);

  // Texte complet récupéré pour les seuls titres à juger ; en cas d'échec, Jev juge le titre
  if (source.fetchBody) for (const h of todo) h.body = await source.fetchBody(h).catch(() => undefined);
  const judged = await judgeHeadlines(todo).catch((err: Error) => {
    alert("error", `Lecture des actualités impossible : Jev n'a pas pu juger ${todo.length} titre(s) de « ${source.name} » (${err.message})`);
    return [];
  });
  if (!judged.length) return;
  // Seules les publications réellement jugées sont marquées : un titre perdu sera repris au prochain passage
  state.seen = [...state.seen, ...judged.map((j) => headlineKey(j.headline))].slice(-MAX_SEEN);
  state.judgments = latest([...state.judgments, ...judged]);

  const tracked = judged.map((j) => track(j, source.kind, state.prices, config.news.minConfidence, Date.now(), config.symbols, config.quote)).filter((e) => e !== null);
  state.events = [...state.events, ...tracked].slice(-MAX_EVENTS);
  tracked.forEach(react);
  console.log(`${source.name} : ${judged.length} nouveau(x) titre(s) jugé(s), ${tracked.length} suivi(s)${skipped.length ? `, ${skipped.length} anciens ignorés au démarrage` : ""}`);
  emit("news", state.judgments);
  if (tracked.length) emit("events", eventsView());
  decideAll();
}

// Relevé des prix à échéance (+5 min, +15 min, +1 h, +4 h) : on lit la bougie 1 min clôturée, même après un redémarrage
async function fillReadings(): Promise<void> {
  // Les événements suivis sous d'anciens symboles (autre devise ou plateforme) ne sont plus relevés
  const due = dueReadings(state.events).filter(({ event }) => config.symbols.includes(event.symbol));
  for (const { event, horizon, at } of due) {
    const candle = await fetchCandleAt(event.symbol, "1m", Math.floor(at / 60_000) * 60_000).catch(() => null);
    if (candle) event.after[horizon] = candle.close;
  }
  if (due.length) emit("events", eventsView());
}

const safely = (task: () => Promise<unknown>) => task().catch((err: Error) => alert("error", `Incident interne : ${err?.message ?? String(err)}`));

// Contrôles d'ouverture en --real : marchés négociables, soldes cohérents avec le portefeuille papier
// Bitvavo n'expose pas les droits d'une clé API : la consigne « clé sans droit de retrait » reste documentaire
async function checkExchange(): Promise<void> {
  if (!config.exchange) return;
  for (const symbol of config.symbols) {
    const filters = await symbolFilters(symbol);
    if (filters.status !== "trading") throw new Error(`exchange : ${symbol} n'est pas négociable (statut ${filters.status})`);
  }
  await reconcile(true);
  setInterval(() => safely(() => reconcile(false)), 3_600_000);
}

// Ce que le bot croit détenir doit exister sur le compte : refus de démarrer, ou drapeau de désynchronisation en cours de route
async function reconcile(atStart: boolean): Promise<void> {
  if (!config.exchange) return;
  const problem = (message: string) => {
    if (atStart) throw new Error(`exchange : ${message}`);
    desync(message);
  };
  const balances = await accountBalances();
  const held = Object.values(state.portfolio.positions).filter((pos) => pos.exchangeQty);
  for (const pos of held) {
    const base = baseOf(pos.symbol, config.quote);
    const free = balances[base] ?? 0;
    if (free + 1e-12 < pos.exchangeQty!) problem(`${pos.exchangeQty} ${base} attendus d'après le portefeuille papier, ${free} disponibles sur le compte`);
  }
  const cash = balances[config.quote] ?? 0;
  if (!held.length && cash < config.startCash) problem(`${cash.toFixed(2)} ${config.quote} disponibles sur le compte, moins que le capital confié au bot (${config.startCash})`);
}

// Un état enregistré dans une autre devise (ancien BTCUSDT en dollars) ne peut pas être repris tel quel
export function staleState(saved: { active?: string[]; quote?: string }, quote: string, symbols: string[]): boolean {
  if (saved.quote && saved.quote !== quote) return true;
  return (saved.active ?? []).some((s) => !symbols.includes(s));
}

export async function start(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (staleState(saved, config.quote, config.symbols)) {
      const backup = `data/state.${new Date().toISOString().replace(/[:.]/g, "-")}.bak.json`;
      await rename(STATE_FILE, backup);
      alert("info", `Simulation précédente archivée dans ${backup} : elle était libellée en ${saved.quote ?? "USDT"} avec des symboles ${(saved.active ?? []).join(", ") || "inconnus"}. Le bot repart d'un portefeuille neuf en ${config.quote}.`);
      throw new Error("état archivé");
    }
    const positions = Object.values(saved.portfolio?.positions ?? {}) as { cost?: number }[];
    const active = (saved.active ?? []).filter((s: string) => config.symbols.includes(s));
    if (active.length && positions.every((p) => p.cost !== undefined)) Object.assign(state, { ...saved, active, seen: saved.seen ?? [] });
    // Positions sauvegardées avant l'ajout du champ `symbol` : la clé était le symbole
    for (const [key, pos] of Object.entries(state.portfolio.positions)) pos.symbol ??= key;
    // Portefeuilles sauvegardés avant les cumuls séparés : on les reconstruit à partir du journal restant
    state.portfolio.totals ??= totalsFrom(state.portfolio.trades);
    state.judgments = latest(state.judgments);
  } catch {}
  try {
    state.events = JSON.parse(await readFile(EVENTS_FILE, "utf8"));
  } catch {}

  await checkExchange();

  startPriceFeed(
    config.symbols,
    (symbol, price) => {
      state.prices[symbol] = price;
      state.feedAt = Date.now();
    },
    (up, detail) => alert(up ? "info" : "warn", detail),
  );
  setInterval(() => emit("tick", live()), 1000);
  setInterval(trackEquity, 60_000);
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

// Prix d'entrée du témoin : le premier achat réel du bot s'il existe (même instant, même prix), sinon le prix courant avec glissement
function ensureHold(): void {
  if (state.portfolio.hold) return;
  const fills = Object.fromEntries(
    state.active.map((symbol) => {
      const first = state.portfolio.trades.find((trade) => trade.side === "BUY" && trade.symbol === symbol);
      return [symbol, first?.price ?? (state.prices[symbol] ?? 0) * (1 + config.slippageBps / 10_000)];
    }),
  );
  startHold(state.portfolio, fills, config.fee);
}

function trackEquity(): void {
  ensureHold();
  recordEquity(state.portfolio, state.prices);
}

// Nouvelle simulation : l'utilisateur choisit les actifs, le bot s'aligne aussitôt sur leur tendance
export async function reset(symbols: string[]): Promise<void> {
  const active = config.symbols.filter((s) => symbols.includes(s));
  if (!active.length) throw new Error("Choisis au moins un actif.");
  // Repartir de zéro en papier alors que l'exchange détient encore des positions désynchroniserait les deux
  if (Object.values(state.portfolio.positions).some((pos) => pos.exchangeQty)) throw new Error("Des positions sont ouvertes sur l'exchange : attends leur vente ou vends-les sur Bitvavo avant de recommencer.");
  state.active = active;
  state.portfolio = newPortfolio(config.startCash);
  state.waits = [];
  decideAll(true);
  trackEquity();
  await persist();
  emit("reset", null);
}

// Backtest sur l'historique réel, mis en cache une heure ; même fonction `decide` que le live
const variant = (result: BacktestResult) => ({ curve: result.strategy, trades: result.trades, stats: result.stats });
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
    holdStats: plain.stats.hold,
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
  const portfolio = state.portfolio;
  const total = equity(portfolio, state.prices);
  return {
    time: Date.now(),
    feedOk: Date.now() - state.feedAt < 5000,
    prices: state.prices,
    signals: state.signals,
    unavailable: state.unavailable,
    desynced: state.desynced,
    equity: total,
    hold: holdValue(portfolio, state.prices) ?? null,
    pnl: total - portfolio.startCash,
    cash: portfolio.cash,
    positions: Object.entries(portfolio.positions).map(([key, pos]) => {
      const price = state.prices[pos.symbol] ?? pos.entryPrice;
      return { ...pos, event: key !== pos.symbol, price, value: pos.qty * price, gain: price / pos.entryPrice - 1 };
    }),
    stats: stats(portfolio),
  };
}

// État complet, chargé une fois à l'ouverture de la page puis après un reset
export function view() {
  const portfolio = state.portfolio;
  return {
    config: {
      symbols: config.symbols,
      quote: config.quote,
      fee: config.fee,
      slippageBps: config.slippageBps,
      mode: config.exchange ? "real" : "paper",
      strategy: config.strategy,
      news: config.news,
      eventRules: config.eventRules,
      backtestYears: config.backtestYears,
    },
    active: state.active,
    alerts: state.alerts,
    startedAt: portfolio.startedAt,
    startCash: portfolio.startCash,
    history: portfolio.history,
    trades: portfolio.trades,
    waits: state.waits,
    judgments: state.judgments,
    events: eventsView(),
    live: live(),
  };
}
