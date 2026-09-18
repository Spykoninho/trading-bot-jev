import { start } from "./bot.js";
import { config } from "./config.js";
import { startServer } from "./server.js";

const { exchange } = config;
if (exchange && !(exchange.key && exchange.secret)) throw new Error(`Clés API manquantes dans .env pour ${exchange.real ? "--real (BINANCE_KEY, BINANCE_SECRET)" : "--live (BINANCE_TESTNET_KEY, BINANCE_TESTNET_SECRET)"}`);
// Garde-fou : en réel, le capital confié au bot doit être déclaré explicitement
if (exchange?.real && !process.env.START_CASH) throw new Error("--real exige START_CASH dans .env : le montant en USDT que tu confies au bot");
console.log(`mode=${exchange ? (exchange.real ? "ORDRES RÉELS sur Binance" : "papier + testnet Binance") : "papier"} capital=${config.startCash} USDT symbols=${config.symbols.join(",")}`);
startServer();
await start();
