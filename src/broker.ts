import { createHmac } from "node:crypto";
import { config } from "./config.js";

export type Side = "BUY" | "SELL";

export type Order = {
  orderId: number;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
};

// Binance signe la query string en HMAC-SHA256 avec le secret API
export function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

async function signedRequest<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) }).toString();
  const url = `${config.binance.testnet}${path}?${query}&signature=${sign(query, config.binance.secret)}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": config.binance.key } });
  if (!res.ok) throw new Error(`Binance testnet ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Ordre MARKET libellé en USDT : le testnet calcule lui-même la quantité d'actif
export function placeMarketOrder(symbol: string, side: Side, quoteUsdt: number): Promise<Order> {
  return signedRequest<Order>("POST", "/api/v3/order", {
    symbol,
    side,
    type: "MARKET",
    quoteOrderQty: quoteUsdt.toFixed(2),
  });
}
