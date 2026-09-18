import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import type { MarketSnapshot } from "../src/market.js";
import { decide, newsScore } from "../src/strategy.js";

const cfg = {
  weights: { news: 0.6, tech: 0.4 },
  thresholds: { buy: 0.25, sell: -0.25, minConfidence: 0.5, minHeadlines: 2, regulatoryRisk: 0.7 },
};

const judgment = (over: Partial<Judgment>): Judgment => ({
  headline: { title: "t", source: "s", publishedAt: "" },
  asset: "BTC",
  assetConfidence: 0.9,
  sentiment: 0.5,
  sentimentConfidence: 0.8,
  material: 0.8,
  regulatoryRisk: 0.1,
  ...over,
});

const market = (signal: number): MarketSnapshot => ({ symbol: "BTCUSDT", price: 1, change24h: 0, sma24: 1, signal });

describe("newsScore", () => {
  it("ignores unrelated assets and low-confidence asset picks", () => {
    const res = newsScore(
      [judgment({}), judgment({ asset: "unrelated", sentiment: -1 }), judgment({ assetConfidence: 0.3, sentiment: -1 })],
      "BTC",
      0.5,
    );
    expect(res).toMatchObject({ score: 0.5, count: 1 });
  });

  it("weights each sentiment by materiality and model confidence", () => {
    const res = newsScore([judgment({ sentiment: 1, material: 1, sentimentConfidence: 1 }), judgment({ sentiment: -1, material: 0.5, sentimentConfidence: 0.5 })], "BTC", 0.5);
    expect(res.score).toBeCloseTo((1 - 0.25) / 1.25);
  });

  it("keeps general crypto news for every base asset", () => {
    expect(newsScore([judgment({ asset: "crypto" })], "ETH", 0.5).count).toBe(1);
  });
});

describe("decide", () => {
  it("holds when fewer than minHeadlines relevant headlines", () => {
    const d = decide(market(1), [judgment({})], cfg);
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("seulement 1");
  });

  it("buys when weighted news + tech exceed the buy threshold", () => {
    const d = decide(market(0.5), [judgment({}), judgment({})], cfg);
    expect(d.action).toBe("BUY");
    expect(d.score).toBeCloseTo(0.6 * 0.5 + 0.4 * 0.5);
  });

  it("blocks a buy when regulatory risk is high", () => {
    const d = decide(market(0.5), [judgment({}), judgment({ regulatoryRisk: 0.9 })], cfg);
    expect(d.action).toBe("HOLD");
    expect(d.reason).toContain("réglementaire");
  });

  it("sells when the score is below the sell threshold", () => {
    expect(decide(market(-0.5), [judgment({ sentiment: -0.75 }), judgment({ sentiment: -0.75 })], cfg).action).toBe("SELL");
  });

  it("holds inside the neutral band", () => {
    expect(decide(market(0), [judgment({ sentiment: 0.1 }), judgment({ sentiment: -0.1 })], cfg).action).toBe("HOLD");
  });
});
