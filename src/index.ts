import { start } from "./bot.js";
import { config, eventsEnabled } from "./config.js";
import { knownSignals } from "./events.js";
import { startServer } from "./server.js";

const { exchange } = config;
// Bitvavo n'offre pas de bac à sable : le mode testnet a disparu avec Binance
if (process.argv.includes("--live")) {
  throw new Error("--live n'existe plus : Bitvavo n'a pas de testnet, et répéter les ordres sur le bac à sable d'une autre plateforme ne testerait pas cet adaptateur. Lance en papier (sans option), puis répète en réel avec --real et un START_CASH très petit.");
}
if (exchange && !(exchange.key && exchange.secret)) throw new Error("Clés API manquantes dans .env pour --real : BITVAVO_API_KEY, BITVAVO_API_SECRET");
if (exchange && !Number.isInteger(exchange.operatorId)) throw new Error("BITVAVO_OPERATOR_ID doit être un entier : Bitvavo l'exige sur chaque ordre");
// Garde-fou : en réel, le capital confié au bot doit être déclaré explicitement
if (exchange?.real && !process.env.START_CASH) throw new Error(`--real exige START_CASH dans .env : le montant en ${config.quote} que tu confies au bot`);
// Jev lit toutes les news : sans clé, le bot n'a ni biais, ni veto, ni circuit événementiel
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY manquante dans .env : le bot ne sait pas juger les news sans elle (https://console.typesafe.ai)");

// Une règle événementielle qui vise un signal que sa source n'émet pas ne se déclencherait jamais en silence
const signals = knownSignals();
for (const rule of config.eventRules) {
  const known = signals[rule.source];
  if (!known) throw new Error(`Règle « ${rule.name} » : source inconnue « ${rule.source} » (sources avec signaux : ${Object.keys(signals).join(", ")})`);
  if (!known.includes(rule.signal)) throw new Error(`Règle « ${rule.name} » : signal inconnu « ${rule.signal} » pour ${rule.source} (disponibles : ${known.join(", ")})`);
}

console.log(`mode=${exchange ? "ORDRES RÉELS sur Bitvavo" : "papier"} capital=${config.startCash} ${config.quote} symbols=${config.symbols.join(",")} frais=${config.fee} glissement=${config.slippageBps} bps`);
console.log(
  eventsEnabled
    ? `circuit événementiel ACTIF : ${config.eventRules.map((r) => r.name).join(", ") || "aucune règle"}`
    : "circuit événementiel DÉSACTIVÉ en réel : la règle ne repose que sur 13 événements, relancer avec --events pour l'activer",
);
startServer();
await start();
