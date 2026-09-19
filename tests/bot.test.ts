import { describe, expect, it } from "vitest";
import { ALERT_REPEAT_MS, latest, shouldAlert, staleState } from "../src/bot.js";
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
