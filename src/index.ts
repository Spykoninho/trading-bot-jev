import { mkdir, writeFile } from "node:fs/promises";
import { judgeHeadlines } from "./brain.js";
import { getBalances, placeMarketOrder } from "./broker.js";
import { config } from "./config.js";
import { marketSnapshot } from "./market.js";
import { fetchHeadlines } from "./news.js";
import { decide, type Decision } from "./strategy.js";

const f = (n: number) => n.toFixed(2);

async function execute(d: Decision, price: number, balances: Record<string, number>): Promise<string> {
  const positionUsdt = (balances[d.symbol.replace("USDT", "")] ?? 0) * price;
  // Gestion du risque en code : une position max par actif, pas de vente à vide
  if (d.action === "BUY" && positionUsdt >= config.orderUsdt / 2) return "skip: already in position";
  if (d.action === "SELL" && positionUsdt < 10) return "skip: no position";
  if (!config.live) return `dry-run ${d.action} ${config.orderUsdt} USDT`;

  const usdt = d.action === "SELL" ? Math.min(config.orderUsdt, positionUsdt * 0.98) : config.orderUsdt;
  const order = await placeMarketOrder(d.symbol, d.action, usdt);
  return `${order.status} #${order.orderId} qty=${order.executedQty} for ${f(Number(order.cummulativeQuoteQty))} USDT`;
}

async function cycle() {
  const [markets, headlines] = await Promise.all([Promise.all(config.symbols.map(marketSnapshot)), fetchHeadlines()]);
  const [judgments, balances] = await Promise.all([judgeHeadlines(headlines), config.binance.key ? getBalances() : {}]);

  console.table(
    judgments.map((j) => ({
      asset: j.asset,
      conf: f(j.assetConfidence),
      sentiment: f(j.sentiment),
      material: f(j.material),
      regRisk: f(j.regulatoryRisk),
      title: j.headline.title.slice(0, 70),
    })),
  );

  const decisions = [];
  for (const market of markets) {
    const d = decide(market, judgments);
    const result = d.action === "HOLD" ? "-" : await execute(d, market.price, balances);
    decisions.push({ ...d, price: market.price, result });
  }
  console.table(
    decisions.map((d) => ({
      symbol: d.symbol,
      price: d.price,
      news: d.newsScore === null ? "-" : f(d.newsScore),
      tech: f(d.techSignal),
      score: f(d.score),
      headlines: d.headlinesUsed,
      action: d.action,
      reason: d.reason,
      result: d.result,
    })),
  );

  // Jugements bruts conservés : la stratégie peut être rejouée avec d'autres poids sans rappeler Jev
  await mkdir("logs", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(`logs/${stamp}.json`, JSON.stringify({ markets, judgments, decisions }, null, 2));
}

async function main() {
  console.log(`mode=${config.live ? "LIVE (testnet)" : "dry-run"} symbols=${config.symbols.join(",")}`);
  do {
    try {
      await cycle();
    } catch (err) {
      console.error(err);
    }
    if (!config.once) await new Promise((r) => setTimeout(r, config.intervalMin * 60_000));
  } while (!config.once);
}

main();
