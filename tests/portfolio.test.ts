import { describe, expect, it } from "vitest";
import { buy, close, equity, newPortfolio, recordEquity, stats } from "../src/portfolio.js";

const order = { symbol: "BTCUSDT", price: 50_000, fee: 0.001, reason: "test" };

describe("buy", () => {
  it("spends cash, charges the fee and opens a position with its entry price", () => {
    const p = newPortfolio(1000);
    const trade = buy(p, { ...order, usdt: 100 });
    expect(p.cash).toBe(900);
    expect(trade?.fee).toBeCloseTo(0.1);
    expect(p.positions.BTCUSDT).toMatchObject({ entryPrice: 50_000, cost: 100 });
    expect(p.positions.BTCUSDT?.qty).toBeCloseTo(99.9 / 50_000);
  });

  it("never spends more than the cash, and refuses tiny or duplicate orders", () => {
    const p = newPortfolio(50);
    expect(buy(p, { ...order, usdt: 100 })?.usdt).toBe(50);
    expect(buy(p, { ...order, usdt: 100 })).toBeNull();
    expect(buy(newPortfolio(1000), { ...order, usdt: 5 })).toBeNull();
  });
});

describe("close", () => {
  it("sells the whole position and reports a P&L net of both fees", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100 });
    const trade = close(p, { ...order, price: 55_000 });
    const gross = (99.9 / 50_000) * 55_000;
    expect(trade?.usdt).toBeCloseTo(gross);
    expect(trade?.pnl).toBeCloseTo(gross * 0.999 - 100);
    expect(p.positions.BTCUSDT).toBeUndefined();
    expect(p.cash).toBeCloseTo(900 + gross * 0.999);
  });

  it("returns null without a position", () => {
    expect(close(newPortfolio(1000), order)).toBeNull();
  });
});

describe("equity and stats", () => {
  it("values positions at current prices and records history", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100, fee: 0 });
    expect(equity(p, { BTCUSDT: 60_000 })).toBeCloseTo(1020);
    recordEquity(p, { BTCUSDT: 60_000 });
    expect(p.history.at(-1)?.equity).toBeCloseTo(1020);
  });

  it("counts closed trades, wins, realized P&L and fees", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100 });
    close(p, { ...order, price: 55_000 });
    buy(p, { ...order, usdt: 100 });
    close(p, { ...order, price: 49_000 });
    const s = stats(p);
    expect(s).toMatchObject({ closed: 2, wins: 1 });
    expect(s.fees).toBeGreaterThan(0.39);
    expect(s.realized).toBeCloseTo(p.cash - 1000);
  });
});
