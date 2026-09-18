import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import type { Position } from "../src/portfolio.js";
import { decide, newsBias } from "../src/strategy.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const cfg = {
  weights: { news: 0.3, tech: 0.7 },
  micro: { fast: 10, slow: 60, saturation: 0.0004, enter: 0.4, exit: -0.2, takeProfit: 0.003, stopLoss: 0.002, maxHoldSec: 300, cooldownSec: 20 },
  news: { minConfidence: 0.5, halfLifeHours: 3, regulatoryRisk: 0.7 },
};

const judgment = (over: Partial<Judgment> & { age?: number } = {}): Judgment => ({
  headline: { title: "t", source: "s", publishedAt: hoursAgo(over.age ?? 0) },
  asset: "BTC",
  assetConfidence: 0.9,
  sentiment: 0.5,
  sentimentConfidence: 0.8,
  material: 0.8,
  regulatoryRisk: 0.1,
  ...over,
});

const flat = Array(180).fill(100);
const rising = [...flat, ...Array.from({ length: 15 }, (_, i) => 100 + (i + 1) * 0.02)];
const falling = [...flat, ...Array.from({ length: 15 }, (_, i) => 100 - (i + 1) * 0.02)];
const position = (entryPrice: number, heldSec = 10): Position => ({ qty: 1, entryPrice, cost: entryPrice, entryTime: new Date(NOW - heldSec * 1000).toISOString() });
const input = (over: Partial<Parameters<typeof decide>[0]>) => ({ symbol: "BTCUSDT", prices: flat, judgments: [], now: NOW, ...over });

describe("newsBias", () => {
  it("ignores unrelated assets and low-confidence asset picks", () => {
    const res = newsBias([judgment(), judgment({ asset: "unrelated", sentiment: -1 }), judgment({ assetConfidence: 0.3, sentiment: -1 })], "BTC", NOW, cfg.news);
    expect(res).toMatchObject({ score: 0.5, count: 1 });
  });

  it("lets fresh headlines outweigh old ones", () => {
    const res = newsBias([judgment({ sentiment: 1 }), judgment({ sentiment: -1, age: 6 })], "BTC", NOW, cfg.news);
    expect(res.score).toBeCloseTo((1 - 0.25) / 1.25);
  });

  it("decays regulatory risk with age and keeps general crypto news for every asset", () => {
    const res = newsBias([judgment({ asset: "crypto", regulatoryRisk: 0.9, age: 3 })], "ETH", NOW, cfg.news);
    expect(res.count).toBe(1);
    expect(res.regulatoryRisk).toBeCloseTo(0.45);
  });
});

describe("decide — entries", () => {
  it("waits until enough price samples are collected", () => {
    expect(decide(input({ prices: [100, 101] }), cfg).reason).toContain("collecte");
  });

  it("buys on a fresh rise and holds on a flat market", () => {
    expect(decide(input({ prices: rising }), cfg).action).toBe("BUY");
    expect(decide(input({ prices: flat }), cfg).action).toBe("HOLD");
  });

  it("lets a bearish news bias veto a moderate micro signal", () => {
    const moderate = [...flat, ...Array.from({ length: 6 }, (_, i) => 100 + (i + 1) * 0.01)];
    const bearish = [judgment({ sentiment: -1 }), judgment({ sentiment: -1 })];
    const alone = decide(input({ prices: moderate }), cfg);
    const vetoed = decide(input({ prices: moderate, judgments: bearish }), cfg);
    expect(vetoed.score).toBeCloseTo(alone.score - 0.3);
  });

  it("blocks entries on fresh regulatory risk and during the cooldown", () => {
    const risky = decide(input({ prices: rising, judgments: [judgment({ regulatoryRisk: 0.9 })] }), cfg);
    expect(risky.action).toBe("HOLD");
    expect(risky.reason).toContain("réglementaire");
    expect(decide(input({ prices: rising, lastExit: NOW - 5_000 }), cfg).reason).toContain("pause");
  });
});

describe("decide — exits", () => {
  it("takes profit, stops losses and caps the holding time", () => {
    expect(decide(input({ position: position(99.6) }), cfg).reason).toContain("objectif");
    expect(decide(input({ position: position(100.3) }), cfg).reason).toContain("stop-loss");
    expect(decide(input({ position: position(100, 400) }), cfg).reason).toContain("durée max");
  });

  it("sells when the signal reverses, otherwise holds the position", () => {
    expect(decide(input({ prices: falling, position: position(99.75) }), cfg).reason).toContain("signal retourné");
    const held = decide(input({ position: position(100) }), cfg);
    expect(held.action).toBe("HOLD");
    expect(held.reason).toContain("en position");
  });
});
