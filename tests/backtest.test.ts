import { describe, expect, it } from "vitest";
import { backtest, curveStats, quantile, tradeProfile } from "../src/backtest.js";
import type { Candle } from "../src/market.js";
import type { Trade } from "../src/portfolio.js";

const cfg = {
  quote: "EUR",
  strategy: { interval: "4h" as const, emaPeriod: 10, band: 0.01, newsTilt: 0.005, window: 1000 },
  news: { minConfidence: 0.5, halfLifeHours: 3, regulatoryRisk: 0.7, windowMs: 24 * 3_600_000, maxKept: 2000, latencyMs: 120_000 },
  fee: 0.001,
  slippageBps: 0,
  startCash: 1000,
  eventReserve: 0.1,
};

const candles = (closes: number[]): Candle[] => closes.map((close, i) => ({ time: i * 14_400_000, open: closes[i - 1] ?? close, high: close, low: close, close }));

// Plat, puis +50 %, puis retour au point de départ
const up = Array.from({ length: 50 }, (_, i) => 100 + i);
const roundTrip = [...Array(25).fill(100), ...up, ...[...up].reverse(), ...Array(10).fill(100)];

describe("backtest", () => {
  it("rides the uptrend, exits on the way down and beats buy & hold on a round trip", () => {
    const r = backtest({ "BTC-EUR": candles(roundTrip) }, cfg);
    expect(r.trades.map((t) => t.side)).toEqual(["BUY", "SELL"]);
    expect(r.stats.closed).toBe(1);
    expect(r.stats.strategy.return).toBeGreaterThan(0.2);
    expect(r.stats.hold.return).toBeCloseTo(-0.001, 3);
    expect(r.stats.strategy.drawdown).toBeLessThan(r.stats.hold.drawdown);
  });

  it("executes at the next candle's open and charges fees on both sides", () => {
    const r = backtest({ "BTC-EUR": candles(roundTrip) }, cfg);
    const [entry, exit] = r.trades;
    const decidedAt = roundTrip.findIndex((c) => c === entry!.price);
    expect(entry!.time).toBe(new Date((decidedAt + 1) * 14_400_000).toISOString());
    expect(r.stats.fees).toBeCloseTo(entry!.fee + exit!.fee);
    // Part égale de l'equity hors réserve événementielle : 90 % de 1000
    expect(entry!.fee).toBeCloseTo(0.9);
  });

  it("keeps the event reserve in cash, like the live bot does", () => {
    const r = backtest({ "BTC-EUR": candles(roundTrip) }, cfg);
    expect(r.trades[0]!.usdt).toBeCloseTo(900);
  });

  it("pays the slippage on both sides of a round trip", () => {
    const r = backtest({ "BTC-EUR": candles(roundTrip) }, { ...cfg, slippageBps: 50 });
    const plain = backtest({ "BTC-EUR": candles(roundTrip) }, cfg);
    expect(r.trades[0]!.price).toBeCloseTo(plain.trades[0]!.price * 1.005);
    expect(r.trades[1]!.price).toBeCloseTo(plain.trades[1]!.price * 0.995);
    expect(r.stats.strategy.return).toBeLessThan(plain.stats.strategy.return);
  });

  it("replays period headlines without look-ahead: a fresh regulatory scare delays the entry by one candle", () => {
    const series = { "BTC-EUR": candles(roundTrip) };
    const entry = Date.parse(backtest(series, cfg).trades[0]!.time);
    const scare = (publishedAt: number) => [
      { headline: { title: "ban", source: "s", publishedAt: new Date(publishedAt).toISOString() }, asset: "BTC" as const, assetConfidence: 1, sentiment: -1, sentimentConfidence: 1, material: 1, regulatoryRisk: 0.95 },
    ];

    const before = backtest(series, cfg, scare(entry - 3_600_000));
    expect(Date.parse(before.trades[0]!.time)).toBe(entry + 14_400_000);

    const after = backtest(series, cfg, scare(entry + 1000));
    expect(Date.parse(after.trades[0]!.time)).toBe(entry);
  });

  it("hides a headline published during the reading latency", () => {
    const series = { "BTC-EUR": candles(roundTrip) };
    const entry = Date.parse(backtest(series, cfg).trades[0]!.time);
    const scare = (publishedAt: number) => [
      { headline: { title: "ban", source: "s", publishedAt: new Date(publishedAt).toISOString() }, asset: "BTC" as const, assetConfidence: 1, sentiment: -1, sentimentConfidence: 1, material: 1, regulatoryRisk: 0.95 },
    ];
    // Paru 1 min avant la décision : le bot ne l'a pas encore lu, il achète quand même
    expect(Date.parse(backtest(series, cfg, scare(entry - 60_000)).trades[0]!.time)).toBe(entry);
  });

  it("splits the capital equally across symbols and aligns series of different lengths", () => {
    const r = backtest({ "BTC-EUR": candles(roundTrip), "ETH-EUR": candles([100, 100, ...roundTrip]) }, cfg);
    const buys = r.trades.filter((t) => t.side === "BUY");
    expect(buys).toHaveLength(2);
    expect(buys[0]!.usdt).toBeCloseTo(450);
    expect(r.times).toHaveLength(r.strategy.length);
    expect(r.hold).toHaveLength(r.strategy.length);
  });
});

describe("curveStats", () => {
  // Série synthétique : 2190 périodes (une année de bougies 4 h) montant de 1 % sur deux, avec un creux au milieu
  const times = Array.from({ length: 2191 }, (_, i) => i * 14_400_000);

  it("annualizes a steady curve: same CAGR as the total return over a year, infinite-like Sharpe", () => {
    const curve = times.map((_, i) => 1000 * 1.0005 ** i);
    const s = curveStats(curve, times, 1000);
    expect(s.return).toBeCloseTo(1.0005 ** 2190 - 1, 6);
    expect(s.cagr).toBeCloseTo(s.return, 2);
    expect(s.drawdown).toBe(0);
    expect(s.mar).toBe(0);
    expect(s.sharpe).toBeGreaterThan(100);
    // Aucune période perdante : le Sortino n'a pas de dénominateur et reste à zéro plutôt que d'exploser
    expect(s.sortino).toBe(0);
  });

  it("measures the worst drawdown and keeps the MAR consistent with the CAGR", () => {
    const curve = [1000, 1200, 900, 1100, 1500];
    const s = curveStats(curve, [0, 14_400_000, 28_800_000, 43_200_000, 57_600_000], 1000);
    expect(s.return).toBeCloseTo(0.5);
    expect(s.drawdown).toBeCloseTo(0.25);
    expect(s.mar).toBeCloseTo(s.cagr / 0.25);
    // Sortino > Sharpe : une seule période perdante, la volatilité haussière ne compte pas
    expect(s.sortino).toBeGreaterThan(s.sharpe);
  });

  it("reads a flat curve as no return, no risk", () => {
    const flat = Array(10).fill(1000);
    const s = curveStats(flat, flat.map((_, i) => i * 14_400_000), 1000);
    expect(s).toMatchObject({ return: 0, drawdown: 0, sharpe: 0, sortino: 0, mar: 0 });
    expect(s.cagr).toBeCloseTo(0);
  });
});

describe("tradeProfile", () => {
  const trade = (pnl: number, cost = 100): Trade => ({ time: "2026-01-01T00:00:00.000Z", symbol: "BTC-EUR", side: "SELL", qty: 1, price: 1, usdt: cost + pnl, fee: 0, reason: "t", pnl });

  it("describes the spread of round trips and how much the best five carry", () => {
    const trades = [trade(50), trade(-10), trade(20), trade(-5), trade(5), trade(300), trade(1), trade(2)];
    const p = tradeProfile([...trades, { ...trade(0), side: "BUY", pnl: undefined }]);
    expect(p.count).toBe(8);
    expect(p.winRate).toBeCloseTo(6 / 8);
    expect(p.worst).toBeCloseTo(-0.1);
    expect(p.median).toBeCloseTo(0.035);
    expect(p.p10).toBeCloseTo(-0.065, 3);
    expect(p.p90).toBeCloseTo(1.25, 3);
    // 300 + 50 + 20 + 5 + 2 sur un gain cumulé de 363
    expect(p.top5Share).toBeCloseTo(377 / 363, 3);
  });

  it("stays defined without any closed trade", () => {
    expect(tradeProfile([])).toMatchObject({ count: 0, winRate: 0, median: 0, worst: 0, top5Share: 0 });
  });
});

describe("quantile", () => {
  it("interpolates between the two neighbouring values", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 1, 2, 3], 0.1)).toBeCloseTo(0.3);
    expect(quantile([7], 0.9)).toBe(7);
  });
});
