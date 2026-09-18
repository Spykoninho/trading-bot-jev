# trading-bot-jev

Bot de trading crypto pédagogique : il lit le marché **réel** sur Binance, fait juger les
news par **Jev**, le modèle System One de [TypeSafe](https://typesafe.ai), et trade sur un
**portefeuille papier** de 1 000 USDT, visible dans une interface web et réinitialisable
à volonté pour une démo.

L'idée à retenir : le code garde le contrôle (indicateurs, poids, seuils, risque, exécution) ;
Jev ne fait que des **jugements typés** sur du texte, là où du code classique ne sait pas lire.

## Setup

```bash
npm install
cp .env.example .env   # puis remplir les clés
```

- `TYPESAFE_API_KEY` : [console.typesafe.ai](https://console.typesafe.ai)
- `BINANCE_TESTNET_KEY` / `SECRET` (optionnel, pour `--live`) :
  [testnet.binance.vision](https://testnet.binance.vision), login GitHub, solde fictif.

Aucune vraie monnaie n'est jamais en jeu.

## Commandes

```bash
npm start                    # bot + interface sur http://localhost:3210
npm start -- --live          # idem, chaque ordre papier est aussi envoyé au testnet Binance
npm start -- --once          # un seul cycle en console, sans interface
npm test                     # vitest
npm run typecheck
```

Pour une démo où l'on veut voir des ordres passer, abaisser les seuils :

```bash
BUY_THRESHOLD=0.1 SELL_THRESHOLD=-0.1 npm start
```

## Interface

- **Portefeuille** : valeur totale, gain/perte depuis le départ, cash, positions, et courbe
  de la valeur dans le temps (un point par minute).
- **Cours** : 72 h de bougies 1 h par crypto suivie, avec un ▲ à chaque achat et un ▼ à chaque vente.
- **Décisions du bot** : pour chaque cycle, le score final entre vendre (−1) et acheter (+1),
  l'action, sa raison, et en dépliant : les 20 jugements bruts de Jev.
- **Ordres exécutés** : quantité, prix, montant, frais (0,1 % comme sur Binance).
- **Lancer un cycle** déclenche un cycle sans attendre l'intervalle ; **Recommencer** remet le
  portefeuille à 1 000 USDT et efface l'historique.

L'état (portefeuille + cycles) est persisté dans `data/state.json`.

## Architecture

```
market.ts     bougies 1h + prix Binance mainnet (sans clé) → SMA 24, signal tech ∈ [-1, 1]
news.ts       RSS CoinDesk + Cointelegraph → 20 titres
brain.ts      1 requête TypeSafe par titre : asset, sentiment, material, regulatory_risk
strategy.ts   composite scoring + confidence gating → BUY / SELL / HOLD
portfolio.ts  portefeuille papier : ordres au prix réel, frais, historique d'équité
broker.ts     miroir optionnel : ordres MARKET signés HMAC sur le testnet Binance
bot.ts        état partagé, tick (prix, 1/min) et cycle (Jev, toutes les INTERVAL_MIN)
server.ts     API Hono locale + fichiers statiques
public/       interface vanilla JS + Chart.js, sans build
```

## Notions TypeSafe utilisées

| Notion | Où | Ce que ça veut dire |
| --- | --- | --- |
| **State** | `brain.ts` | Le contexte envoyé au modèle : un objet à champs nommés (`headline`, `source`, `published_at`). |
| **Choice** | `asset` | Une option parmi un ensemble fermé. Retourne `choice`, `probabilities` par option et `confidence`. |
| **Score** | `sentiment` | Une position sur des niveaux **ordonnés et décrits par des situations concrètes**. `score` est la moyenne pondérée des niveaux (peut tomber entre deux). |
| **Noul** | `material`, `regulatory_risk` | Probabilité qu'une condition soit vraie (0 → non, 1 → oui). 0,5 = incertain, pas « moyen ». |
| **Fan-out** | `brain.ts` | Toutes les questions d'une requête sont évaluées en parallèle : en ajouter ne coûte presque rien. |
| **Composite scoring** | `strategy.ts` | Le modèle donne des signaux atomiques ; le code les combine avec des poids qu'il contrôle. |
| **Confidence gating** | `strategy.ts` | Pas assez de titres pertinents ou choix d'actif peu sûr → `HOLD` plutôt que deviner. |
| **Règle séparée** | `strategy.ts` | Un risque réglementaire élevé bloque tout achat, indépendamment du score pondéré. |
| **Jugements réutilisables** | `data/state.json` | Les réponses brutes sont conservées : changer les poids ne nécessite pas de rappeler le modèle. |

## Notions de simulation

- **Mainnet public** (`api.binance.com`) : données de marché réelles, sans authentification.
- **Portefeuille papier** : chaque ordre est exécuté au dernier prix réel, plafonné par le cash
  (achat) ou la position (vente), avec 0,1 % de frais. Une seule position par actif ; une
  vente clôture toute la position.
- **Spot Testnet** (`testnet.binance.vision`) : même API que Binance, solde fictif non
  réinitialisable. Les endpoints signés exigent `X-MBX-APIKEY`, un `timestamp` et une
  `signature` HMAC-SHA256 de la query string. `MARKET` + `quoteOrderQty` : on donne un
  montant en USDT, Binance calcule la quantité.

## Limites

Pas de backtest, pas de stop-loss, un seul flux de décision. Les seuils (`config.ts`) sont des
points de départ à évaluer sur tes propres cycles, pas des vérités. Le serveur n'écoute que sur
`127.0.0.1` et n'a pas d'authentification : ne pas l'exposer tel quel.
