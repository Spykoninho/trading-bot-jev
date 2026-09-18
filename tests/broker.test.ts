import { describe, expect, it } from "vitest";
import { floorToStep, netBaseQty, sign } from "../src/broker.js";

// Vecteur de test officiel de la doc Binance (SIGNED endpoint example)
describe("sign", () => {
  it("matches the Binance documentation example", () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(sign(query, secret)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });
});

describe("floorToStep", () => {
  it("rounds a quantity down to the exchange lot size, never up", () => {
    expect(floorToStep(0.00012987, 0.00001)).toBe(0.00012);
    expect(floorToStep(1.23456, 0.001)).toBe(1.234);
    expect(floorToStep(3.999, 1)).toBe(3);
    expect(floorToStep(0.0005, 0.0001)).toBe(0.0005);
  });
});

describe("netBaseQty", () => {
  const order = (fills: { commission: string; commissionAsset: string }[]) => ({ orderId: 1, status: "FILLED", executedQty: "0.01000000", fills: fills.map((f) => ({ qty: "0.01", ...f })) });

  it("subtracts fees charged in the bought asset, so the bot never tries to sell more than it holds", () => {
    expect(netBaseQty(order([{ commission: "0.00001", commissionAsset: "BTC" }]), "BTC")).toBeCloseTo(0.00999);
  });

  it("keeps the full quantity when fees are paid in another asset such as BNB", () => {
    expect(netBaseQty(order([{ commission: "0.0001", commissionAsset: "BNB" }]), "BTC")).toBe(0.01);
    expect(netBaseQty({ orderId: 1, status: "FILLED", executedQty: "0.01" }, "BTC")).toBe(0.01);
  });
});
