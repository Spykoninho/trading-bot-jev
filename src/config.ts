try {
  process.loadEnvFile(".env");
} catch {}

const env = process.env;
const argv = process.argv.slice(2);

export const config = {
  symbols: (env.SYMBOLS ?? "BTCUSDT,ETHUSDT").split(","),
  orderUsdt: Number(env.ORDER_USDT ?? 100),
  intervalMin: Number(env.INTERVAL_MIN ?? 15),
  // Sans --live, aucun ordre n'est envoyé au testnet
  live: argv.includes("--live"),
  once: argv.includes("--once"),
  // Poids et seuils de la stratégie : c'est le code qui décide, pas le modèle
  weights: { news: 0.6, tech: 0.4 },
  thresholds: {
    buy: 0.25,
    sell: -0.25,
    minConfidence: 0.5,
    minHeadlines: 2,
    regulatoryRisk: 0.7,
  },
  binance: {
    data: "https://api.binance.com",
    testnet: "https://testnet.binance.vision",
    key: env.BINANCE_TESTNET_KEY ?? "",
    secret: env.BINANCE_TESTNET_SECRET ?? "",
  },
};

export type Config = typeof config;
