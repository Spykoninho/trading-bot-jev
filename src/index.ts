import { start } from "./bot.js";
import { config } from "./config.js";
import { startServer } from "./server.js";

console.log(`mode=${config.live ? "papier + miroir testnet" : "papier"} symbols=${config.symbols.join(",")}`);
startServer();
await start();
