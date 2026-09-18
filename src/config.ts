try {
  process.loadEnvFile(".env");
} catch {}

const env = process.env;
const argv = process.argv.slice(2);

export const config = {
  symbols: (env.SYMBOLS ?? "BTCUSDT,ETHUSDT").split(","),
  // Portefeuille papier local : capital de départ, taille d'ordre, frais type Binance (0,1 %)
  startCash: Number(env.START_CASH ?? 1000),
  orderUsdt: Number(env.ORDER_USDT ?? 100),
  fee: 0.001,
  intervalMin: Number(env.INTERVAL_MIN ?? 15),
  tickSec: 60,
  port: Number(env.PORT ?? 3210),
  // --live : chaque ordre papier est aussi envoyé au testnet Binance
  live: argv.includes("--live"),
  once: argv.includes("--once"),
  // Poids et seuils de la stratégie : c'est le code qui décide, pas le modèle
  weights: { news: 0.6, tech: 0.4 },
  thresholds: {
    buy: Number(env.BUY_THRESHOLD ?? 0.25),
    sell: Number(env.SELL_THRESHOLD ?? -0.25),
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
