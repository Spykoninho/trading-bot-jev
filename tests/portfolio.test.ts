import { describe, expect, it } from "vitest";
import { buy, close, equity, holdValue, newPortfolio, recordEquity, startHold, stats, totalsFrom } from "../src/portfolio.js";

const order = { symbol: "BTC-EUR", price: 50_000, fee: 0.001, reason: "test" };

describe("buy", () => {
  it("spends cash, charges the fee and opens a position with its entry price", () => {
    const p = newPortfolio(1000);
    const trade = buy(p, { ...order, usdt: 100 });
    expect(p.cash).toBe(900);
    expect(trade?.fee).toBeCloseTo(0.1);
    expect(p.positions["BTC-EUR"]).toMatchObject({ entryPrice: 50_000, cost: 100 });
    expect(p.positions["BTC-EUR"]?.qty).toBeCloseTo(99.9 / 50_000);
  });

  it("never spends more than the cash, and refuses tiny or duplicate orders", () => {
    const p = newPortfolio(50);
    expect(buy(p, { ...order, usdt: 100 })?.usdt).toBe(50);
    expect(buy(p, { ...order, usdt: 100 })).toBeNull();
    expect(buy(newPortfolio(1000), { ...order, usdt: 5 })).toBeNull();
  });

  it("keeps the event reserve untouched: a trend buy never eats into the floor", () => {
    const p = newPortfolio(1000);
    // 100 de réserve : l'achat est rogné à 900 même s'il en demande plus
    expect(buy(p, { ...order, usdt: 1000, floor: 100 })?.usdt).toBe(900);
    expect(p.cash).toBe(100);
    // Le reste de la réserve est hors d'atteinte d'un second achat de tendance
    expect(buy(p, { ...order, symbol: "ETH-EUR", usdt: 500, floor: 100 })).toBeNull();
    // La poche événementielle, elle, y puise sans plancher
    expect(buy(p, { ...order, symbol: "ETH-EUR", book: "event", usdt: 100 })?.usdt).toBe(100);
  });

  it("fills a market order slightly above the quoted price, and a sale slightly below", () => {
    const p = newPortfolio(1000);
    const bought = buy(p, { ...order, usdt: 100, slippageBps: 50 });
    expect(bought?.price).toBeCloseTo(50_250);
    expect(p.positions["BTC-EUR"]?.entryPrice).toBeCloseTo(50_250);
    const sold = close(p, { ...order, slippageBps: 50 });
    expect(sold?.price).toBeCloseTo(49_750);
    expect(sold!.pnl!).toBeLessThan(0);
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
    expect(p.positions["BTC-EUR"]).toBeUndefined();
    expect(p.cash).toBeCloseTo(900 + gross * 0.999);
  });

  it("hands the quantity really held on the exchange over to the closing trade", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100 });
    p.positions["BTC-EUR"]!.exchangeQty = 0.00199;
    expect(close(p, order)?.exchangeQty).toBe(0.00199);
  });

  it("returns null without a position", () => {
    expect(close(newPortfolio(1000), order)).toBeNull();
  });
});

describe("event book", () => {
  it("keeps an event position next to the trend position on the same symbol, each closed on its own", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 400 });
    const event = buy(p, { ...order, usdt: 100, book: "event", exitAt: "2026-01-01T16:00:00.000Z" });
    expect(event?.usdt).toBe(100);
    expect(Object.keys(p.positions)).toEqual(["BTC-EUR", "event:BTC-EUR"]);
    expect(p.positions["event:BTC-EUR"]).toMatchObject({ symbol: "BTC-EUR", exitAt: "2026-01-01T16:00:00.000Z" });
    expect(equity(p, { "BTC-EUR": 50_000 })).toBeCloseTo(1000 - 0.5);

    close(p, { ...order, book: "event" });
    expect(Object.keys(p.positions)).toEqual(["BTC-EUR"]);
  });
});

describe("equity and stats", () => {
  it("values positions at current prices and records history", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100, fee: 0 });
    expect(equity(p, { "BTC-EUR": 60_000 })).toBeCloseTo(1020);
    recordEquity(p, { "BTC-EUR": 60_000 });
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

  it("keeps counting after the trade journal has been truncated", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100 });
    const realized = close(p, { ...order, price: 55_000 })!.pnl!;
    // Journal vidé comme le fait la troncature : le bilan ne bouge pas
    p.trades.length = 0;
    expect(stats(p)).toMatchObject({ closed: 1, wins: 1 });
    expect(stats(p).realized).toBeCloseTo(realized);
  });

  it("rebuilds the totals of a portfolio saved before they existed", () => {
    const p = newPortfolio(1000);
    buy(p, { ...order, usdt: 100 });
    close(p, { ...order, price: 55_000 });
    expect(totalsFrom(p.trades)).toEqual(stats(p));
  });
});

describe("témoin acheter et garder", () => {
  it("répartit tout le capital à parts égales, frais payés une fois, puis ne bouge plus", () => {
    const p = newPortfolio(1000);
    startHold(p, { "BTC-USDC": 100, "ETH-USDC": 10 }, 0.001);
    expect(p.hold!["BTC-USDC"]).toBeCloseTo(4.995);
    expect(p.hold!["ETH-USDC"]).toBeCloseTo(49.95);
    expect(holdValue(p, { "BTC-USDC": 100, "ETH-USDC": 10 })).toBeCloseTo(999);
    expect(holdValue(p, { "BTC-USDC": 200, "ETH-USDC": 10 })).toBeCloseTo(1498.5);
    startHold(p, { "BTC-USDC": 1 }, 0);
    expect(Object.keys(p.hold!)).toHaveLength(2);
  });

  it("attend d'avoir un prix pour chaque actif et s'inscrit dans l'historique", () => {
    const p = newPortfolio(1000);
    startHold(p, { "BTC-USDC": 100, "ETH-USDC": 0 }, 0);
    expect(p.hold).toBeUndefined();
    recordEquity(p, { "BTC-USDC": 100 });
    expect(p.history[0]!.hold).toBeUndefined();
    startHold(p, { "BTC-USDC": 100 }, 0);
    expect(holdValue(p, {})).toBeUndefined();
    recordEquity(p, { "BTC-USDC": 110 });
    expect(p.history[1]!.hold).toBeCloseTo(1100);
  });
});
