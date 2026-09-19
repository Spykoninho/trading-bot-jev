import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandleAt, fetchCandles, fetchHistory, RECONNECT, reconnectDelay } from "../src/market.js";

afterEach(() => vi.unstubAllGlobals());

const row = (time: number, close: number) => [time, String(close), String(close + 1), String(close - 1), String(close), "1"];

describe("fetchCandles", () => {
  it("names the market and the HTTP status when Bitvavo refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 451, statusText: "Unavailable For Legal Reasons" })));
    await expect(fetchCandles("BTC-EUR", "4h")).rejects.toThrow(/BTC-EUR 4h : HTTP 451/);
  });

  it("maps rows to numeric candles and puts them back in chronological order", async () => {
    // Bitvavo répond de la plus récente à la plus ancienne
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([row(120_000, 3), row(60_000, 2)]), { status: 200 })));
    expect(await fetchCandles("BTC-EUR", "1m", 2)).toEqual([
      { time: 60_000, open: 2, high: 3, low: 1, close: 2 },
      { time: 120_000, open: 3, high: 4, low: 2, close: 3 },
    ]);
  });
});

describe("fetchCandleAt", () => {
  it("takes the last candle at or before the target minute, since Bitvavo skips minutes without a trade", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([row(300_000, 9), row(120_000, 3)]), { status: 200 })));
    expect((await fetchCandleAt("BTC-EUR", "1m", 240_000))?.close).toBe(3);
  });

  it("returns nothing when no candle precedes the target", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    expect(await fetchCandleAt("BTC-EUR", "1m", 240_000)).toBeUndefined();
  });
});

describe("fetchHistory", () => {
  it("walks backwards with `end` until it covers the period, without duplicating the joins", async () => {
    const step = 14_400_000;
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const end = Number(new URL(String(url)).searchParams.get("end")) || now;
        // Trois bougies par page, de plus en plus anciennes
        return new Response(JSON.stringify([2, 1, 0].map((i) => row(end - (3 - i) * step, 100 + i))), { status: 200 });
      }),
    );
    const candles = await fetchHistory("BTC-EUR", "4h", 1 / 365);
    expect(candles.length).toBeGreaterThan(0);
    expect(new Set(candles.map((c) => c.time)).size).toBe(candles.length);
    expect([...candles].sort((a, b) => a.time - b.time)).toEqual(candles);
  });
});

describe("reconnectDelay", () => {
  it("doubles the delay at each attempt and caps it", () => {
    expect(reconnectDelay(0, () => 1)).toBe(RECONNECT.min);
    expect(reconnectDelay(1, () => 1)).toBe(2 * RECONNECT.min);
    expect(reconnectDelay(3, () => 1)).toBe(8 * RECONNECT.min);
    expect(reconnectDelay(20, () => 1)).toBe(RECONNECT.max);
  });

  it("keeps a jitter between half and full delay", () => {
    expect(reconnectDelay(2, () => 0)).toBe(2000);
    expect(reconnectDelay(2, () => 0.999)).toBeLessThanOrEqual(4000);
    const spread = Array.from({ length: 50 }, () => reconnectDelay(4));
    expect(Math.min(...spread)).toBeGreaterThanOrEqual(8000);
    expect(Math.max(...spread)).toBeLessThanOrEqual(16_000);
  });
});
