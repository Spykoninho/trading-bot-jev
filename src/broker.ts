import { createHmac, randomUUID } from "node:crypto";
import { config } from "./config.js";

export type Side = "BUY" | "SELL";

type Fill = { amount: string; fee?: string; feeCurrency?: string };
type Order = { orderId: string; status: string; filledAmount: string; filledAmountQuote: string; feePaid?: string; feeCurrency?: string; fills?: Fill[] };

export type SymbolFilters = { symbol: string; status: string; stepSize: string; minQty: number; minNotional: number; quoteDecimals: number };
export type SellResult = { orderId: string; status: string; executedQty: number; remaining: number };
export type AccountBalances = Record<string, number>;

// Vente incomplète : porte le détail pour que l'appelant sache ce qui reste en portefeuille
export class SellIncompleteError extends Error {
  result: SellResult;
  constructor(symbol: string, result: SellResult) {
    super(`vente ${symbol} incomplète : statut ${result.status}, exécuté ${result.executedQty}, reliquat ${result.remaining}`);
    this.name = "SellIncompleteError";
    this.result = result;
  }
}

// Bitvavo signe en HMAC-SHA256 la concaténation timestamp + méthode + chemin /v2/... + corps
export function sign(timestamp: number, method: string, path: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${method}${path}${body}`).digest("hex");
}

function exchange(): { key: string; secret: string; operatorId: number; real: boolean } {
  const ex = config.exchange;
  if (!ex) throw new Error("exchange : aucun compte configuré (lancer avec --real)");
  return ex;
}

// Rien de secret ne doit sortir dans un message d'erreur ou un log
function scrub(text: string): string {
  const ex = config.exchange;
  let out = text.replace(/(Bitvavo-Access-(?:Key|Signature))[:=]\s*[^&\s"]+/gi, "$1=***");
  if (ex?.key) out = out.split(ex.key).join("***");
  if (ex?.secret) out = out.split(ex.secret).join("***");
  return out.slice(0, 400);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Bitvavo répond 429 (errorCode 105) et bloque 1 min sur clé, 15 min sur IP ; `bitvavo-ratelimit-resetat` dit quand ça repart
function retryAfterMs(res: Response): number {
  const resetAt = Number(res.headers.get("bitvavo-ratelimit-resetat") ?? 0);
  const wait = resetAt ? resetAt - Date.now() : 0;
  return Math.min(Math.max(wait, 1000), 60_000);
}

// 429 : on attend la réinitialisation du quota et on ne retente qu'une fois, jamais sur un ordre (risque de doublon)
async function request(url: string, init: RequestInit, label: string, retry: boolean): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;
  const wait = retryAfterMs(res);
  if (!retry) throw new Error(`Bitvavo ${label} : limite de débit (429), ordre non renvoyé, réessayer dans ${Math.round(wait / 1000)} s`);
  await sleep(wait);
  const again = await fetch(url, init);
  if (again.status === 429) throw new Error(`Bitvavo ${label} : limite de débit (429) toujours active après ${Math.round(wait / 1000)} s`);
  return again;
}

async function publicGet<T>(path: string, label: string): Promise<T> {
  const res = await request(`${config.bitvavo.rest}${path}`, {}, label, true);
  if (!res.ok) throw new Error(`Bitvavo ${label} : HTTP ${res.status} ${scrub(await res.text())}`);
  return res.json() as Promise<T>;
}

let clockOffset: number | null = null;

// Dérive d'horloge : Bitvavo rejette toute requête signée hors de la fenêtre Bitvavo-Access-Window
async function syncClock(): Promise<void> {
  const { time } = await publicGet<{ time: number }>("/time", "time");
  clockOffset = time - Date.now();
}

export function clockSkewMs(): number {
  return clockOffset ?? 0;
}

const WINDOW_MS = 10_000;

async function signedRequest<T>(path: string, body: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
  if (clockOffset === null) await syncClock();
  const { key, secret } = exchange();
  const payload = method === "GET" || body === undefined ? "" : JSON.stringify(body);
  const timestamp = Date.now() + clockOffset!;
  const headers: Record<string, string> = {
    "Bitvavo-Access-Key": key,
    "Bitvavo-Access-Timestamp": String(timestamp),
    "Bitvavo-Access-Window": String(WINDOW_MS),
    "Bitvavo-Access-Signature": sign(timestamp, method, `/v2${path}`, payload, secret),
  };
  if (payload) headers["content-type"] = "application/json";
  const res = await request(`${config.bitvavo.rest}${path}`, { method, headers, ...(payload ? { body: payload } : {}) }, path, method === "GET");
  const text = await res.text();
  if (!res.ok) throw new Error(`Bitvavo ${path} : HTTP ${res.status} ${scrub(text)}`);
  return JSON.parse(text) as T;
}

// Quantité réellement reçue : à l'achat Bitvavo prélève ses frais en euros, mais il facture parfois dans l'actif acheté
export function netBaseQty(order: Order, base: string): number {
  const fromFills = (order.fills ?? []).filter((f) => f.feeCurrency === base).reduce((sum, f) => sum + Number(f.fee ?? 0), 0);
  const fee = fromFills || (order.feeCurrency === base ? Number(order.feePaid ?? 0) : 0);
  return Number(order.filledAmount) - fee;
}

// Le pas n'est pas toujours une puissance de 10 (0,05 par exemple) : les décimales viennent du texte renvoyé par l'API
function stepDecimals(step: string): number {
  const [mantissa = "", exponent] = step.trim().toLowerCase().split("e");
  return Math.max(0, (mantissa.split(".")[1] ?? "").length - Number(exponent ?? 0));
}

// Une quantité vendue doit être un multiple entier du pas de cotation, arrondi vers le bas
export function floorToStep(qty: number, step: number | string): number {
  const text = typeof step === "string" ? step : String(step);
  const size = Number(text);
  if (!(size > 0)) return qty;
  const ratio = qty / size;
  return Number((Math.floor(ratio + Math.max(1e-9, ratio * 1e-12)) * size).toFixed(stepDecimals(text)));
}

type RawMarket = { market: string; status: string; quantityDecimals: number; notionalDecimals: number; minOrderInBaseAsset: string; minOrderInQuoteAsset: string };

const filters = new Map<string, SymbolFilters>();

// Filtres de marché mis en cache : pas de cotation, quantité minimale, montant minimal et état du marché
export async function symbolFilters(symbol: string): Promise<SymbolFilters> {
  const cached = filters.get(symbol);
  if (cached) return cached;
  const info = await publicGet<RawMarket | RawMarket[]>(`/markets?market=${symbol}`, `markets ${symbol}`);
  const found = Array.isArray(info) ? info[0] : info;
  if (!found?.market) throw new Error(`Bitvavo markets : marché ${symbol} introuvable`);
  const value: SymbolFilters = {
    symbol: found.market,
    status: found.status,
    // Bitvavo donne un nombre de décimales, pas un pas : 8 décimales → 0.00000001
    stepSize: (10 ** -found.quantityDecimals).toFixed(found.quantityDecimals),
    minQty: Number(found.minOrderInBaseAsset ?? 0),
    minNotional: Number(found.minOrderInQuoteAsset ?? 0),
    quoteDecimals: found.notionalDecimals ?? 2,
  };
  filters.set(symbol, value);
  return value;
}

// Vide le cache des filtres et l'offset d'horloge (tests, ou reprise après une longue coupure)
export function resetBrokerCache(): void {
  filters.clear();
  clockOffset = null;
}

// Bitvavo exige un clientOrderId au format UUID : on le dérive du libellé stable de l'ordre papier
export function clientOrderId(seed?: string): string {
  if (!seed) return randomUUID();
  const h = createHmac("sha256", "jev").update(seed).digest("hex");
  // UUID v8 (usage libre) déterministe : rejouer le même ordre papier ne le duplique pas chez Bitvavo
  const variant = (((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80) >> 4).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Achat au marché libellé en devise de cotation ; renvoie la quantité d'actif réellement détenue ensuite
export async function marketBuy(symbol: string, quoteAmount: number, seed?: string): Promise<number> {
  const f = await symbolFilters(symbol);
  if (f.status !== "trading") throw new Error(`achat ${symbol} refusé : marché non négociable (statut ${f.status})`);
  if (f.minNotional > 0 && quoteAmount < f.minNotional) throw new Error(`achat ${symbol} refusé : ${quoteAmount.toFixed(2)} ${config.quote} sous le montant minimum ${f.minNotional} ${config.quote}`);
  const order = await signedRequest<Order>("/order", {
    market: symbol,
    side: "buy",
    orderType: "market",
    operatorId: exchange().operatorId,
    clientOrderId: clientOrderId(seed),
    amountQuote: quoteAmount.toFixed(f.quoteDecimals),
  });
  if (order.status !== "filled") throw new Error(`achat ${symbol} non exécuté entièrement : statut ${order.status}, ${order.filledAmountQuote} ${config.quote} investis`);
  return netBaseQty(order, symbol.split("-")[0]!);
}

// Vente au marché de la quantité exacte achetée par le bot : le reste du compte n'est jamais touché
export async function marketSell(symbol: string, qty: number, price?: number, seed?: string): Promise<SellResult> {
  const f = await symbolFilters(symbol);
  if (f.status !== "trading") throw new Error(`vente ${symbol} refusée : marché non négociable (statut ${f.status})`);
  const amount = floorToStep(qty, f.stepSize);
  if (amount <= 0 || amount < f.minQty) throw new Error(`vente ${symbol} refusée : ${amount} sous la quantité minimale ${f.minQty} (pas ${f.stepSize})`);
  if (price !== undefined && f.minNotional > 0 && amount * price < f.minNotional) {
    throw new Error(`vente ${symbol} refusée : ${(amount * price).toFixed(2)} ${config.quote} sous le montant minimum ${f.minNotional} ${config.quote}`);
  }
  const order = await signedRequest<Order>("/order", {
    market: symbol,
    side: "sell",
    orderType: "market",
    operatorId: exchange().operatorId,
    clientOrderId: clientOrderId(seed),
    amount: String(amount),
  });
  const executedQty = Number(order.filledAmount ?? 0);
  const result: SellResult = { orderId: order.orderId, status: order.status, executedQty, remaining: Number(Math.max(0, amount - executedQty).toFixed(stepDecimals(f.stepSize))) };
  if (order.status !== "filled") throw new SellIncompleteError(symbol, result);
  return result;
}

// Soldes disponibles du compte, actif par actif : sert à vérifier qu'on détient bien ce qu'on croit détenir
export async function accountBalances(): Promise<AccountBalances> {
  const balances = await signedRequest<{ symbol: string; available: string }[]>("/balance", undefined, "GET");
  return Object.fromEntries(balances.map((b) => [b.symbol, Number(b.available)]));
}
