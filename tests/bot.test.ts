import { describe, expect, it } from "vitest";
import { ALERT_REPEAT_MS, appendWait, isList, journal, latest, shouldAlert, staleState, type Wait } from "../src/bot.js";
import type { Judgment } from "../src/brain.js";
import { config } from "../src/config.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const judgment = (title: string, age = 0): Judgment => ({
  headline: { title, source: "CoinDesk", publishedAt: hoursAgo(age) },
  asset: "BTC",
  assetConfidence: 0.9,
  sentiment: 0.5,
  sentimentConfidence: 0.8,
  material: 0.8,
  regulatoryRisk: 0.1,
});

describe("latest", () => {
  it("keeps one entry per publication, the most recent first", () => {
    const kept = latest([judgment("a", 2), judgment("b", 1), judgment("a", 2)], NOW);
    expect(kept.map((j) => j.headline.title)).toEqual(["b", "a"]);
  });

  it("drops the headlines older than the window the backtest uses too", () => {
    const window = config.news.windowMs / 3_600_000;
    const kept = latest([judgment("frais", window - 1), judgment("périmé", window + 1)], NOW);
    expect(kept.map((j) => j.headline.title)).toEqual(["frais"]);
  });

  it("caps the number kept, whatever the window, as a memory guard", () => {
    const many = Array.from({ length: config.news.maxKept + 50 }, (_, i) => judgment(`t${i}`, i / 3600));
    expect(latest(many, NOW)).toHaveLength(config.news.maxKept);
  });
});

describe("shouldAlert", () => {
  it("logs the same message at most once per ten minutes", () => {
    const seen = new Map<string, number>();
    expect(shouldAlert(seen, "flux coupé", NOW)).toBe(true);
    expect(shouldAlert(seen, "flux coupé", NOW + ALERT_REPEAT_MS - 1)).toBe(false);
    expect(shouldAlert(seen, "flux coupé", NOW + ALERT_REPEAT_MS)).toBe(true);
  });

  it("never silences a different message", () => {
    const seen = new Map<string, number>();
    expect(shouldAlert(seen, "flux coupé", NOW)).toBe(true);
    expect(shouldAlert(seen, "ordre refusé", NOW)).toBe(true);
  });
});

describe("staleState", () => {
  const symbols = ["BTC-EUR", "ETH-EUR"];

  it("archives a state saved in another currency", () => {
    expect(staleState({ quote: "USDT", active: ["BTCUSDT"] }, "EUR", symbols)).toBe(true);
  });

  it("archives a state whose symbols are no longer those of the configuration", () => {
    expect(staleState({ active: ["BTCUSDT"] }, "EUR", symbols)).toBe(true);
  });

  it("keeps a state that matches the current currency and symbols", () => {
    expect(staleState({ quote: "EUR", active: ["BTC-EUR"] }, "EUR", symbols)).toBe(false);
  });
});

describe("appendWait", () => {
  const wait = (symbol: string, h: number, reason = "attente"): Wait => ({ time: hoursAgo(h), symbol, price: 100, reason });

  it("merges the successive waits of an asset into one run that remembers when it started", () => {
    const waits = [wait("BTC-EUR", 8), wait("BTC-EUR", 4), wait("BTC-EUR", 0, "dernière")].reduce<Wait[]>((acc, w) => appendWait(acc, [], w), []);
    expect(waits).toEqual([{ ...wait("BTC-EUR", 0, "dernière"), since: hoursAgo(8), count: 3 }]);
  });

  it("starts a new run once an order has been placed on the asset", () => {
    let waits = appendWait([], [], wait("BTC-EUR", 8));
    waits = appendWait(waits, [{ time: hoursAgo(6), symbol: "BTC-EUR" }], wait("BTC-EUR", 4));
    expect(waits.map((w) => [w.since, w.count])).toEqual([
      [hoursAgo(8), 1],
      [hoursAgo(4), 1],
    ]);
  });

  it("keeps one run per asset, unaffected by the orders of another asset", () => {
    let waits = appendWait([], [], wait("BTC-EUR", 8));
    waits = appendWait(waits, [], wait("ETH-EUR", 8));
    waits = appendWait(waits, [{ time: hoursAgo(6), symbol: "ETH-EUR" }], wait("BTC-EUR", 4));
    expect(waits.map((w) => [w.symbol, w.count])).toEqual([
      ["ETH-EUR", 1],
      ["BTC-EUR", 2],
    ]);
  });
});

describe("journal", () => {
  it("lists orders and wait runs newest first, flagging the run still in progress", () => {
    const trade = { time: hoursAgo(6), symbol: "BTC-EUR", side: "BUY" as const, qty: 1, price: 100, usdt: 100, fee: 0, reason: "achat" };
    const waits: Wait[] = [
      { time: hoursAgo(8), symbol: "BTC-EUR", price: 90, reason: "a", since: hoursAgo(20), count: 4 },
      { time: hoursAgo(0), symbol: "BTC-EUR", price: 110, reason: "b", since: hoursAgo(4), count: 2 },
    ];
    expect(journal([trade], waits).map((e) => [e.side, "open" in e ? e.open : null])).toEqual([
      ["HOLD", true],
      ["BUY", null],
      ["HOLD", false],
    ]);
  });
});

describe("isList", () => {
  it("accepts the dashboard lists and rejects inherited object keys", () => {
    expect(["journal", "news", "events"].every(isList)).toBe(true);
    expect(["constructor", "__proto__", "toString", "waits"].some(isList)).toBe(false);
  });
});
