import { createHmac } from "node:crypto";
import { config } from "./config.js";

export type Side = "BUY" | "SELL";

type Fill = { qty: string; commission: string; commissionAsset: string };
type Order = { orderId: number; status: string; executedQty: string; fills?: Fill[] };

// Binance signe la query string en HMAC-SHA256 avec le secret API
export function sign(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

// Même API pour le testnet (--live) et pour Binance réel (--real) : seuls l'URL et les clés changent
async function signedRequest<T>(path: string, params: Record<string, string>): Promise<T> {
  const { url, key, secret } = config.exchange!;
  const query = new URLSearchParams({ ...params, recvWindow: "5000", timestamp: String(Date.now()) }).toString();
  const res = await fetch(`${url}${path}?${query}&signature=${sign(query, secret)}`, { method: "POST", headers: { "X-MBX-APIKEY": key } });
  if (!res.ok) throw new Error(`Binance ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Quantité réellement reçue : Binance prélève ses frais sur l'actif acheté (sauf paiement en BNB)
export function netBaseQty(order: Order, base: string): number {
  const fees = (order.fills ?? []).filter((f) => f.commissionAsset === base).reduce((sum, f) => sum + Number(f.commission), 0);
  return Number(order.executedQty) - fees;
}

// Une quantité vendue doit être un multiple du pas de cotation (filtre LOT_SIZE), arrondi vers le bas
export function floorToStep(qty: number, step: number): number {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(qty / step + 1e-9) * step).toFixed(decimals));
}

const steps = new Map<string, number>();

async function stepSize(symbol: string): Promise<number> {
  if (!steps.has(symbol)) {
    const res = await fetch(`${config.exchange!.url}/api/v3/exchangeInfo?symbol=${symbol}`);
    if (!res.ok) throw new Error(`Binance exchangeInfo ${symbol}: ${res.status}`);
    const info = (await res.json()) as { symbols: { filters: { filterType: string; stepSize?: string }[] }[] };
    steps.set(symbol, Number(info.symbols[0]!.filters.find((f) => f.filterType === "LOT_SIZE")!.stepSize));
  }
  return steps.get(symbol)!;
}

// Achat MARKET libellé en USDT ; renvoie la quantité d'actif réellement détenue ensuite
export async function marketBuy(symbol: string, usdt: number): Promise<number> {
  const order = await signedRequest<Order>("/api/v3/order", { symbol, side: "BUY", type: "MARKET", quoteOrderQty: usdt.toFixed(2), newOrderRespType: "FULL" });
  return netBaseQty(order, symbol.replace("USDT", ""));
}

// Vente MARKET de la quantité exacte achetée par le bot : le reste du wallet n'est jamais touché
export async function marketSell(symbol: string, qty: number): Promise<void> {
  await signedRequest<Order>("/api/v3/order", { symbol, side: "SELL", type: "MARKET", quantity: String(floorToStep(qty, await stepSize(symbol))) });
}
