try {
  process.loadEnvFile(".env");
} catch {}

const env = process.env;

export const config = {
  symbols: (env.SYMBOLS ?? "BTCUSDT,ETHUSDT").split(","),
  // Portefeuille papier local : capital de départ, taille d'ordre, frais type Binance (0,1 %)
  startCash: Number(env.START_CASH ?? 1000),
  orderUsdt: Number(env.ORDER_USDT ?? 100),
  fee: Number(env.FEE ?? 0.001),
  port: Number(env.PORT ?? 3210),
  // --live : chaque ordre papier est aussi envoyé au testnet Binance
  live: process.argv.includes("--live"),
  // Cadence de décision réglable depuis l'interface (0 = pause)
  speeds: { Pause: 0, Lent: 10_000, Normal: 2_000, Rapide: 1_000 },
  newsEverySec: 60,
  // Poids et seuils : c'est le code qui décide, Jev ne fournit que le biais news
  weights: { news: 0.3, tech: 0.7 },
  micro: {
    fast: 10, // EMA rapide, en secondes
    slow: 60, // EMA lente, en secondes
    saturation: 0.0002, // écart EMA (0,02 %) qui sature le signal à ±1
    enter: 0.4,
    exit: -0.2,
    takeProfit: 0.003,
    stopLoss: 0.002,
    maxHoldSec: 300,
    cooldownSec: 20,
  },
  news: {
    minConfidence: 0.5,
    halfLifeHours: 3,
    regulatoryRisk: 0.7,
  },
  binance: {
    data: "https://api.binance.com",
    stream: "wss://stream.binance.com:9443",
    testnet: "https://testnet.binance.vision",
    key: env.BINANCE_TESTNET_KEY ?? "",
    secret: env.BINANCE_TESTNET_SECRET ?? "",
  },
};

export type Config = typeof config;
