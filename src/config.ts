try {
  process.loadEnvFile(".env");
} catch {}

const env = process.env;

export const config = {
  // Actifs proposés à chaque nouvelle simulation ; chacun a son option dans la question `asset` de Jev (brain.ts)
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  // Portefeuille papier local : le capital est réparti à parts égales entre les actifs choisis
  startCash: Number(env.START_CASH ?? 1000),
  fee: Number(env.FEE ?? 0.001),
  port: Number(env.PORT ?? 3210),
  // --live : chaque ordre papier est aussi envoyé au testnet Binance
  live: process.argv.includes("--live"),
  candlesEverySec: 60,
  // Suivi de tendance retenu par backtest (3 ans, frais inclus) : voir README
  strategy: {
    interval: "4h" as const,
    emaPeriod: 200,
    band: 0.01, // hystérésis : achat au-dessus de EMA × 1,01, vente sous EMA × 0,99
    newsTilt: 0.005, // le biais news de Jev décale les seuils d'au plus ±0,5 %
    window: 1000, // bougies clôturées utilisées pour chaque décision, en live comme en backtest
  },
  news: {
    minConfidence: 0.5,
    halfLifeHours: 3,
    regulatoryRisk: 0.7,
  },
  backtestYears: 3,
  binance: {
    data: "https://api.binance.com",
    stream: "wss://stream.binance.com:9443",
    testnet: "https://testnet.binance.vision",
    key: env.BINANCE_TESTNET_KEY ?? "",
    secret: env.BINANCE_TESTNET_SECRET ?? "",
  },
};

export type Config = typeof config;
