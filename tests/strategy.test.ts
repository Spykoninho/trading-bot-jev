import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import type { Position } from "../src/portfolio.js";
import { decide, newsBias, trendRegime } from "../src/strategy.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const cfg = {
  strategy: { interval: "4h" as const, emaPeriod: 10, band: 0.01, newsTilt: 0.005, window: 1000 },
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

const flat = Array(30).fill(100);
const rising = [...flat, 101, 102, 103, 104, 105];
const falling = [...flat, 99, 98, 97, 96, 95];
const position: Position = { qty: 1, entryPrice: 100, cost: 100, entryTime: hoursAgo(10) };
const input = (over: Partial<Parameters<typeof decide>[0]>) => ({ symbol: "BTCUSDT", closes: flat, judgments: [], now: NOW, ...over });

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

describe("trendRegime", () => {
  it("turns up above the band, down below it, and keeps its state in between", () => {
    expect(trendRegime(flat, cfg.strategy).trend).toBe("none");
    expect(trendRegime(rising, cfg.strategy).trend).toBe("up");
    expect(trendRegime(falling, cfg.strategy).trend).toBe("down");
    // Retour dans la bande après une hausse : la tendance reste haussière (hystérésis)
    expect(trendRegime([...rising, 103.5], cfg.strategy).trend).toBe("up");
  });

  it("shifts both thresholds down when the news tilt is positive", () => {
    const neutral = trendRegime(flat, cfg.strategy);
    const bullish = trendRegime(flat, cfg.strategy, 0.005);
    expect(neutral.buyAbove).toBeCloseTo(101);
    expect(bullish.buyAbove).toBeCloseTo(100.5);
    expect(bullish.sellBelow).toBeCloseTo(98.5);
  });
});

describe("decide", () => {
  it("waits for enough history", () => {
    expect(decide(input({ closes: [100, 101] }), cfg).reason).toContain("historique insuffisant");
  });

  it("buys in an uptrend, stays out otherwise", () => {
    expect(decide(input({ closes: rising }), cfg).action).toBe("BUY");
    expect(decide(input({ closes: flat }), cfg).action).toBe("HOLD");
    expect(decide(input({ closes: falling }), cfg).action).toBe("HOLD");
  });

  it("sells when the trend breaks, holds the position otherwise", () => {
    expect(decide(input({ closes: falling, position }), cfg).action).toBe("SELL");
    const held = decide(input({ closes: rising, position }), cfg);
    expect(held.action).toBe("HOLD");
    expect(held.reason).toContain("en position");
  });

  it("blocks entries on fresh regulatory risk", () => {
    const d = decide(input({ closes: rising, judgments: [judgment({ regulatoryRisk: 0.9 })] }), cfg);
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("réglementaire");
  });

  it("lets bullish news trigger an entry that neutral news would not", () => {
    const edge = [...flat, 100.9];
    const bullish = [judgment({ sentiment: 1 }), judgment({ sentiment: 1 })];
    expect(decide(input({ closes: edge }), cfg).action).toBe("HOLD");
    expect(decide(input({ closes: edge, judgments: bullish }), cfg).action).toBe("BUY");
  });
});
