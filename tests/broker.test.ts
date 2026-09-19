import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountBalances, clientOrderId, clockSkewMs, floorToStep, marketBuy, marketSell, netBaseQty, resetBrokerCache, SellIncompleteError, sign, symbolFilters } from "../src/broker.js";
import { config } from "../src/config.js";

const KEY = "MYKEY123";
const SECRET = "MYSECRET456";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const MARKET = {
  market: "BTC-EUR",
  status: "trading",
  base: "BTC",
  quote: "EUR",
  minOrderInBaseAsset: "0.00007324",
  minOrderInQuoteAsset: "5.00",
  quantityDecimals: 8,
  notionalDecimals: 2,
};

let calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];

function stubFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
      return route(String(url), init);
    }),
  );
}

// Routeur par défaut : marchés, heure serveur, soldes et ordres
const routes = (over: Record<string, (url: string) => Response | Promise<Response>> = {}) => {
  return (url: string) => {
    const hit = Object.keys(over).find((k) => url.includes(k));
    if (hit) return over[hit]!(url);
    if (url.includes("/markets")) return json([MARKET]);
    if (url.includes("/time")) return json({ time: Date.now() });
    return json({ orderId: "o-1", status: "filled", filledAmount: "0.01000000", filledAmountQuote: "700.00" });
  };
};

const lastBody = () => JSON.parse(calls.at(-1)!.body!) as Record<string, unknown>;

const realQuote = config.quote;

beforeEach(() => {
  config.exchange = { key: KEY, secret: SECRET, operatorId: 42, real: true };
  // Indépendant du .env de la machine : les messages d'erreur citent la devise configurée
  config.quote = "EUR";
  resetBrokerCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  config.exchange = null;
  config.quote = realQuote;
});

// Vecteur calculé à la main : HMAC-SHA256 de timestamp + méthode + chemin /v2/... + corps
describe("sign", () => {
  const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";

  it("signs timestamp + method + path + body for a POST", () => {
    const body = JSON.stringify({ market: "BTC-EUR", side: "buy", orderType: "market", operatorId: 543462, amountQuote: "100.00" });
    expect(sign(1548172481125, "POST", "/v2/order", body, secret)).toBe("d654b0cd48bc6b852cdf536107a6cfc1c263710a4e771b6f5a7abce8d483ad06");
  });

  it("signs an empty body for a GET", () => {
    expect(sign(1548172481125, "GET", "/v2/balance", "", secret)).toBe("cc7660541d70b1789cbc4c7904ed6f74bf9ff2af72ae6d966fbb7880b4e37105");
  });
});

describe("clientOrderId", () => {
  it("derives a stable UUID from the paper order, so replaying it does not duplicate the order", () => {
    const id = clientOrderId("jev-b-BTC-EUR-abc");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(clientOrderId("jev-b-BTC-EUR-abc")).toBe(id);
    expect(clientOrderId("jev-b-BTC-EUR-xyz")).not.toBe(id);
  });
});

describe("floorToStep", () => {
  it("rounds a quantity down to the exchange lot size, never up", () => {
    expect(floorToStep(0.00012987, 0.00001)).toBe(0.00012);
    expect(floorToStep(1.23456, 0.001)).toBe(1.234);
    expect(floorToStep(3.999, 1)).toBe(3);
    expect(floorToStep(0.0005, 0.0001)).toBe(0.0005);
  });

  it("handles steps that are not powers of ten", () => {
    expect(floorToStep(1.23, 0.05)).toBe(1.2);
    expect(floorToStep(0.15, 0.05)).toBe(0.15);
    expect(floorToStep(0.149, 0.05)).toBe(0.1);
    expect(floorToStep(12.5, 5)).toBe(10);
  });

  it("reads the decimals from the step size text sent by the API", () => {
    expect(floorToStep(1.23456789, "0.00100000")).toBe(1.234);
    expect(floorToStep(0.00012987, "0.00001000")).toBe(0.00012);
    expect(floorToStep(0.0000345, "1e-5")).toBe(0.00003);
  });
});

describe("netBaseQty", () => {
  const order = (over: Record<string, unknown>) => ({ orderId: "o-1", status: "filled", filledAmount: "0.01000000", filledAmountQuote: "700.00", ...over });

  it("keeps the whole quantity when Bitvavo charges its fee in euros", () => {
    expect(netBaseQty(order({ feePaid: "1.75", feeCurrency: "EUR" }), "BTC")).toBe(0.01);
    expect(netBaseQty(order({}), "BTC")).toBe(0.01);
  });

  it("subtracts a fee charged in the bought asset, so the bot never tries to sell more than it holds", () => {
    expect(netBaseQty(order({ feePaid: "0.00001", feeCurrency: "BTC" }), "BTC")).toBeCloseTo(0.00999);
    expect(netBaseQty(order({ fills: [{ amount: "0.01", fee: "0.00001", feeCurrency: "BTC" }] }), "BTC")).toBeCloseTo(0.00999);
  });
});

describe("symbolFilters", () => {
  it("reads the lot size, minimums and trading status of a market", async () => {
    stubFetch(routes());
    expect(await symbolFilters("BTC-EUR")).toEqual({ symbol: "BTC-EUR", status: "trading", stepSize: "0.00000001", minQty: 0.00007324, minNotional: 5, quoteDecimals: 2 });
  });

  it("accepts a bare object as well as an array", async () => {
    stubFetch(routes({ "/markets": () => json(MARKET) }));
    expect((await symbolFilters("BTC-EUR")).minNotional).toBe(5);
  });

  it("caches the answer so every order does not hit /markets", async () => {
    stubFetch(routes());
    await symbolFilters("BTC-EUR");
    await symbolFilters("BTC-EUR");
    expect(calls.filter((c) => c.url.includes("/markets"))).toHaveLength(1);
  });

  it("reports a missing market instead of crashing", async () => {
    stubFetch(routes({ "/markets": () => json([]) }));
    await expect(symbolFilters("NOPE-EUR")).rejects.toThrow(/introuvable/);
  });
});

describe("clock drift", () => {
  it("offsets signed timestamps with the server time", async () => {
    stubFetch(routes({ "/time": () => json({ time: Date.now() + 8000 }), "/balance": () => json([{ symbol: "EUR", available: "100" }]) }));
    await accountBalances();
    expect(Number(calls.at(-1)!.headers["Bitvavo-Access-Timestamp"]) - Date.now()).toBeGreaterThan(7000);
    expect(clockSkewMs()).toBeGreaterThan(7000);
  });
});

describe("rate limit", () => {
  it("waits for the quota reset then retries a GET once", async () => {
    vi.useFakeTimers();
    let first = true;
    stubFetch(
      routes({
        "/markets": () => {
          if (!first) return json([MARKET]);
          first = false;
          return new Response("", { status: 429, headers: { "bitvavo-ratelimit-resetat": String(Date.now() + 2000) } });
        },
      }),
    );
    const pending = symbolFilters("BTC-EUR");
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect((await pending).status).toBe("trading");
    expect(calls).toHaveLength(2);
  });

  it("never resends an order blindly and says how long to wait", async () => {
    stubFetch(routes({ "/order": () => new Response("", { status: 429, headers: { "bitvavo-ratelimit-resetat": String(Date.now() + 30_000) } }) }));
    await expect(marketSell("BTC-EUR", 0.01)).rejects.toThrow(/limite de débit \(429\).*30 s/s);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("marketBuy", () => {
  it("sends amountQuote, the operatorId and a client order id, and returns the quantity actually held", async () => {
    stubFetch(routes());
    expect(await marketBuy("BTC-EUR", 300, "jev-b-1")).toBe(0.01);
    expect(lastBody()).toMatchObject({ market: "BTC-EUR", side: "buy", orderType: "market", operatorId: 42, amountQuote: "300.00" });
    expect(lastBody().clientOrderId).toBe(clientOrderId("jev-b-1"));
  });

  it("refuses an amount below the market minimum before reaching Bitvavo", async () => {
    stubFetch(routes());
    await expect(marketBuy("BTC-EUR", 2)).rejects.toThrow(/sous le montant minimum 5 EUR/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("raises when the order did not fill completely", async () => {
    stubFetch(routes({ "/order": () => json({ orderId: "o-2", status: "partiallyFilled", filledAmount: "0.004", filledAmountQuote: "280.00" }) }));
    await expect(marketBuy("BTC-EUR", 300)).rejects.toThrow(/non exécuté entièrement/);
  });
});

describe("marketSell", () => {
  it("floors the quantity to the market precision and returns the fill", async () => {
    stubFetch(routes({ "/order": () => json({ orderId: "o-3", status: "filled", filledAmount: "0.01001999", filledAmountQuote: "700.00" }) }));
    expect(await marketSell("BTC-EUR", 0.0100199999, 60_000)).toEqual({ orderId: "o-3", status: "filled", executedQty: 0.01001999, remaining: 0 });
    // 8 décimales de quantité sur BTC-EUR : la neuvième est rognée, jamais arrondie vers le haut
    expect(lastBody()).toMatchObject({ market: "BTC-EUR", side: "sell", orderType: "market", operatorId: 42, amount: "0.01001999" });
  });

  it("raises an exploitable error on a partial fill", async () => {
    stubFetch(routes({ "/order": () => json({ orderId: "o-7", status: "partiallyFilled", filledAmount: "0.00400000", filledAmountQuote: "280.00" }) }));
    const failure = await marketSell("BTC-EUR", 0.01).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SellIncompleteError);
    expect((failure as SellIncompleteError).result).toEqual({ orderId: "o-7", status: "partiallyFilled", executedQty: 0.004, remaining: 0.006 });
  });

  it("refuses a quantity below the lot minimum before reaching Bitvavo", async () => {
    stubFetch(routes());
    await expect(marketSell("BTC-EUR", 0.000001)).rejects.toThrow(/sous la quantité minimale/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses a sale below the minimum amount when a price is given", async () => {
    stubFetch(routes());
    await expect(marketSell("BTC-EUR", 0.0001, 100)).rejects.toThrow(/sous le montant minimum 5 EUR/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("refuses to trade a halted market", async () => {
    stubFetch(routes({ "/markets": () => json([{ ...MARKET, status: "halted" }]) }));
    await expect(marketSell("BTC-EUR", 0.01)).rejects.toThrow(/non négociable/);
  });
});

describe("account endpoints", () => {
  it("maps available balances by asset and signs a GET", async () => {
    stubFetch(routes({ "/balance": () => json([{ symbol: "EUR", available: "1234.50", inOrder: "0" }, { symbol: "BTC", available: "0.002", inOrder: "0" }]) }));
    expect(await accountBalances()).toEqual({ EUR: 1234.5, BTC: 0.002 });
    expect(calls.at(-1)!.method).toBe("GET");
    expect(calls.at(-1)!.body).toBeUndefined();
    expect(calls.at(-1)!.headers["Bitvavo-Access-Key"]).toBe(KEY);
  });
});

describe("secrets", () => {
  it("never leaks the api key or the signature in an error message", async () => {
    stubFetch(routes({ "/order": (url: string) => new Response(`bad request for ${url} with key ${KEY} and secret ${SECRET}`, { status: 400 }) }));
    const message = await marketSell("BTC-EUR", 0.01).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(message).toContain("HTTP 400");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(SECRET);
  });
});
