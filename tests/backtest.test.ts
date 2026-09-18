import { describe, expect, it } from "vitest";
import { backtest } from "../src/backtest.js";
import type { Candle } from "../src/market.js";

const cfg = {
  strategy: { interval: "4h" as const, emaPeriod: 10, band: 0.01, newsTilt: 0.005, window: 1000 },
  news: { minConfidence: 0.5, halfLifeHours: 3, regulatoryRisk: 0.7 },
  fee: 0.001,
  startCash: 1000,
};

const candles = (closes: number[]): Candle[] => closes.map((close, i) => ({ time: i * 14_400_000, open: closes[i - 1] ?? close, high: close, low: close, close }));

// Plat, puis +50 %, puis retour au point de départ
const up = Array.from({ length: 50 }, (_, i) => 100 + i);
const roundTrip = [...Array(25).fill(100), ...up, ...[...up].reverse(), ...Array(10).fill(100)];

describe("backtest", () => {
  it("rides the uptrend, exits on the way down and beats buy & hold on a round trip", () => {
    const r = backtest({ BTCUSDT: candles(roundTrip) }, cfg);
    expect(r.trades.map((t) => t.side)).toEqual(["BUY", "SELL"]);
    expect(r.stats.closed).toBe(1);
    expect(r.stats.strategyReturn).toBeGreaterThan(0.2);
    expect(r.stats.holdReturn).toBeCloseTo(-0.001, 3);
    expect(r.stats.strategyDrawdown).toBeLessThan(r.stats.holdDrawdown);
  });

  it("executes at the next candle's open and charges fees on both sides", () => {
    const r = backtest({ BTCUSDT: candles(roundTrip) }, cfg);
    const [entry, exit] = r.trades;
    const decidedAt = roundTrip.findIndex((c) => c === entry!.price);
    expect(entry!.time).toBe(new Date((decidedAt + 1) * 14_400_000).toISOString());
    expect(r.stats.fees).toBeCloseTo(entry!.fee + exit!.fee);
    expect(entry!.fee).toBeCloseTo(1);
  });

  it("splits the capital equally across symbols and aligns series of different lengths", () => {
    const r = backtest({ BTCUSDT: candles(roundTrip), ETHUSDT: candles([100, 100, ...roundTrip]) }, cfg);
    const buys = r.trades.filter((t) => t.side === "BUY");
    expect(buys).toHaveLength(2);
    expect(buys[0]!.usdt).toBeCloseTo(500);
    expect(r.times).toHaveLength(r.strategy.length);
    expect(r.hold).toHaveLength(r.strategy.length);
  });
});
