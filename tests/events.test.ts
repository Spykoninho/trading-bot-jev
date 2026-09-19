import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import { dueReadings, matchRule, scoreboard, symbolFor, track, type TrackedEvent } from "../src/events.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const prices = { "BTC-EUR": 100, "ETH-EUR": 50 };

const judgment = (over: Partial<Judgment> = {}): Judgment => ({
  headline: { title: "t", source: "Fed", publishedAt: new Date(NOW - 20_000).toISOString() },
  asset: "crypto",
  assetConfidence: 0.9,
  sentiment: -0.8,
  sentimentConfidence: 0.8,
  material: 0.9,
  regulatoryRisk: 0.1,
  ...over,
});

const event = (over: Partial<TrackedEvent> = {}): TrackedEvent => ({ ...track(judgment(), "primaire", prices, 0.5, NOW)!, ...over });

describe("track", () => {
  it("records the live price, the latency and Jev's direction at the moment the item is seen", () => {
    expect(track(judgment(), "primaire", prices, 0.5, NOW)).toMatchObject({ symbol: "BTC-EUR", priceAtSeen: 100, latencySec: 20, direction: -1, kind: "primaire", after: {} });
    expect(track(judgment({ asset: "ETH", sentiment: 0.5 }), "presse", prices, 0.5, NOW)).toMatchObject({ symbol: "ETH-EUR", direction: 1 });
  });

  it("ignores unrelated items, unsure asset picks, assets without a live price and items not caught live", () => {
    expect(track(judgment({ headline: { title: "old", source: "Fed", publishedAt: new Date(NOW - 3_600_000).toISOString() } }), "primaire", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ asset: "unrelated" }), "presse", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ assetConfidence: 0.3 }), "presse", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ asset: "SOL" }), "presse", prices, 0.5, NOW)).toBeNull();
  });
});

describe("symbolFor", () => {
  it("maps a judged asset to a configured symbol, the whole market being measured on BTC", () => {
    expect(symbolFor("crypto")).toBe("BTC-EUR");
    expect(symbolFor("ETH")).toBe("ETH-EUR");
    expect(symbolFor("unrelated")).toBeUndefined();
    // Actifs et devise de cotation fournis par l'appelant : plus de table codée en dur
    expect(symbolFor("SOL", ["BTC-USDC", "SOL-USDC"], "USDC")).toBe("SOL-USDC");
    expect(symbolFor("ETH", ["BTC-EUR"])).toBeUndefined();
  });
});

describe("matchRule", () => {
  const rules = [{ name: "Trump soutient la crypto", source: "Trump (Truth Social)", signal: "crypto_support", min: 0.8, share: 0.1, holdMin: 240 }];
  const post = (source: string, crypto_support: number) => event({ judgment: judgment({ headline: { title: "t", source, publishedAt: new Date(NOW).toISOString() }, signals: { crypto_support } }) });

  it("fires only for the rule's source and when Jev's signal is strong enough", () => {
    expect(matchRule(post("Trump (Truth Social)", 0.93), rules)?.name).toBe("Trump soutient la crypto");
    expect(matchRule(post("Trump (Truth Social)", 0.55), rules)).toBeUndefined();
    expect(matchRule(post("CoinDesk", 0.93), rules)).toBeUndefined();
    expect(matchRule(event(), rules)).toBeUndefined();
  });

  it("ignores archived judgments that predate the signals, instead of reading their display text", () => {
    const archived = event({ judgment: judgment({ headline: { title: "t", source: "Trump (Truth Social)", publishedAt: new Date(NOW).toISOString() }, details: { "Soutien crypto": "0.93" } }) });
    expect(matchRule(archived, rules)).toBeUndefined();
  });
});

describe("dueReadings", () => {
  it("lists only the horizons whose minute has closed and that are still missing", () => {
    const e = event({ after: { 5: 101 } });
    expect(dueReadings([e], NOW + 10 * 60_000)).toEqual([]);
    const due = dueReadings([e], NOW + 61 * 60_000);
    expect(due.map((r) => r.horizon)).toEqual([15, 60]);
    expect(due[0]!.at).toBe(NOW + 15 * 60_000);
  });
});

describe("scoreboard", () => {
  it("averages returns in Jev's direction, split by impact", () => {
    const events = [event({ after: { 60: 98 } }), event({ after: { 60: 101 } }), event({ judgment: judgment({ material: 0.2 }), after: { 60: 99 } })];
    const s = scoreboard(events);
    expect(s).toMatchObject({ tracked: 3, medianLatencySec: 20 });
    expect(s.groups.fort![60]).toMatchObject({ n: 2, wins: 1 });
    expect(s.groups.fort![60]!.mean).toBeCloseTo(0.005);
    expect(s.groups.autres![60]).toMatchObject({ n: 1, wins: 1 });
    expect(s.groups.fort![5]).toMatchObject({ n: 0, mean: null });
  });
});
