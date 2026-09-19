try {
  process.loadEnvFile(".env");
} catch {}

const env = process.env;
const flag = (name: string) => process.argv.includes(name);

// Bitvavo n'a pas de bac à sable : deux modes seulement, papier par défaut et --real qui envoie de vrais ordres
const BITVAVO = { rest: "https://api.bitvavo.com/v2", ws: "wss://ws.bitvavo.com/v2/" };

// Devise de cotation : USDC par défaut (frais 5× plus bas qu'en EUR, et vendre contre un stablecoin n'est pas une sortie en euros)
const quote = (env.QUOTE ?? "USDC").trim().toUpperCase();
// Actifs proposés à chaque simulation ; chacun a son option dans la question `asset` de Jev (brain.ts)
const bases = (env.BASES ?? "BTC,ETH,SOL")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)
  // On accepte aussi bien « BTC » que « BTC-EUR » : la devise de cotation est retirée puis rajoutée
  .map((s) => (s.endsWith(`-${quote}`) ? s.slice(0, -(quote.length + 1)) : s));

// Circuit immédiat : seules les règles soutenues par l'étude d'événements (npm run study), sur une part réservée du capital
const EVENT_RULES = [{ name: "Trump soutient la crypto", source: "Trump (Truth Social)", signal: "crypto_support", min: 0.8, share: 0.1, holdMin: 240 }];
const real = flag("--real");
// La règle ne repose que sur n=13 : gardée en papier, exigée explicitement (--events) avec de l'argent réel
export const eventsEnabled = !real || flag("--events");

export const config = {
  quote,
  bases,
  symbols: bases.map((base) => `${base}-${quote}`),
  // Portefeuille papier local : chaque achat de tendance prend une part égale de l'equity courante, sans rééquilibrage ensuite
  startCash: Number(env.START_CASH ?? 1000),
  // Bitvavo catégorie B (paires en USDC) : 0,05 % maker comme taker ; en EUR (catégorie A) mettre FEE=0.0025
  fee: Number(env.FEE ?? 0.0005),
  // Glissement appliqué au prix d'exécution, en points de base : on achète un peu au-dessus, on vend un peu en dessous
  // 4 bps : le carnet USDC est ~40× moins profond que l'EUR (écart achat/vente mesuré de 3 à 5 bps)
  slippageBps: Number(env.SLIPPAGE_BPS ?? 4),
  port: Number(env.PORT ?? 3210),
  // Local seulement par défaut ; 0.0.0.0 uniquement dans un conteneur dont le port n'est publié que sur 127.0.0.1
  host: env.HOST ?? "127.0.0.1",
  exchange: real ? { key: env.BITVAVO_API_KEY ?? "", secret: env.BITVAVO_API_SECRET ?? "", operatorId: Number(env.BITVAVO_OPERATOR_ID ?? 1), real: true } : null,
  candlesEverySec: 60,
  // Suivi de tendance retenu par backtest (3 ans, frais inclus) : voir README
  strategy: {
    interval: "4h" as const,
    emaPeriod: 200,
    band: 0.01, // hystérésis : achat au-dessus de EMA × 1,01, vente sous EMA × 0,99
    newsTilt: 0.005, // le biais news de Jev décale les seuils d'au plus ±0,5 %
    window: 1000, // bougies clôturées utilisées pour chaque décision, en live comme en backtest
  },
  eventRules: eventsEnabled ? EVENT_RULES : [],
  eventReserve: 0.1,
  news: {
    minConfidence: 0.5,
    halfLifeHours: 3,
    regulatoryRisk: 0.7,
    // Fenêtre glissante des titres pris en compte, en direct comme en backtest
    windowMs: 24 * 3_600_000,
    // Garde-fou mémoire : le direct ne garde jamais plus de jugements que cela, même dans la fenêtre
    maxKept: 2000,
    // Latence réaliste entre la parution et le moment où le bot peut agir, appliquée au backtest
    latencyMs: 120_000,
  },
  // Les paires USDC de Bitvavo n'existent que depuis juillet 2024 : l'historique disponible borne la période
  backtestYears: Number(env.BACKTEST_YEARS ?? 3),
  bitvavo: BITVAVO,
};

export type Config = typeof config;
