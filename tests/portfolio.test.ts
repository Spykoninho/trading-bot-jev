import { describe, expect, it } from "vitest";
import { applyOrder, equity, newPortfolio, recordEquity } from "../src/portfolio.js";

const order = { symbol: "BTCUSDT", price: 50_000, fee: 0.001, reason: "test" };

describe("applyOrder", () => {
  it("buys with cash and charges the fee on the spent amount", () => {
    const p = newPortfolio(1000);
    const trade = applyOrder(p, { ...order, side: "BUY", usdt: 100 });
    expect(p.cash).toBe(900);
    expect(trade?.fee).toBeCloseTo(0.1);
    expect(p.positions.BTCUSDT).toBeCloseTo(99.9 / 50_000);
  });

  it("never spends more than the available cash", () => {
    const p = newPortfolio(50);
    expect(applyOrder(p, { ...order, side: "BUY", usdt: 100 })?.usdt).toBe(50);
    expect(p.cash).toBe(0);
  });

  it("sells at most the held position and closes it", () => {
    const p = newPortfolio(1000);
    applyOrder(p, { ...order, side: "BUY", usdt: 100 });
    const trade = applyOrder(p, { ...order, side: "SELL", usdt: Infinity, price: 55_000 });
    expect(trade?.usdt).toBeCloseTo(109.89);
    expect(p.positions.BTCUSDT).toBeUndefined();
    expect(p.cash).toBeCloseTo(900 + 109.89 * 0.999);
  });

  it("ignores orders below the minimum notional", () => {
    const p = newPortfolio(1000);
    expect(applyOrder(p, { ...order, side: "SELL", usdt: 100 })).toBeNull();
    expect(applyOrder(p, { ...order, side: "BUY", usdt: 5 })).toBeNull();
    expect(p.trades).toHaveLength(0);
  });
});

describe("equity", () => {
  it("values cash plus positions at current prices and records history", () => {
    const p = newPortfolio(1000);
    applyOrder(p, { ...order, side: "BUY", usdt: 100, fee: 0 });
    expect(equity(p, { BTCUSDT: 60_000 })).toBeCloseTo(900 + 120);
    recordEquity(p, { BTCUSDT: 60_000 });
    expect(p.history.at(-1)).toMatchObject({ equity: 1020, cash: 900 });
  });
});
