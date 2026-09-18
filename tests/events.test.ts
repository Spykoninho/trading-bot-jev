import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import { dueReadings, scoreboard, track, type TrackedEvent } from "../src/events.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const prices = { BTCUSDT: 100, ETHUSDT: 50 };

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
    expect(track(judgment(), "primaire", prices, 0.5, NOW)).toMatchObject({ symbol: "BTCUSDT", priceAtSeen: 100, latencySec: 20, direction: -1, kind: "primaire", after: {} });
    expect(track(judgment({ asset: "ETH", sentiment: 0.5 }), "presse", prices, 0.5, NOW)).toMatchObject({ symbol: "ETHUSDT", direction: 1 });
  });

  it("ignores unrelated items, unsure asset picks, assets without a live price and items not caught live", () => {
    expect(track(judgment({ headline: { title: "old", source: "Fed", publishedAt: new Date(NOW - 3_600_000).toISOString() } }), "primaire", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ asset: "unrelated" }), "presse", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ assetConfidence: 0.3 }), "presse", prices, 0.5, NOW)).toBeNull();
    expect(track(judgment({ asset: "SOL" }), "presse", prices, 0.5, NOW)).toBeNull();
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
