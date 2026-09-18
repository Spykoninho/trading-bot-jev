# trading-bot-jev

Bot de **micro-trading** crypto pédagogique : il suit les prix Binance **en temps réel**, fait
juger chaque nouvelle news par **Jev**, le modèle System One de [TypeSafe](https://typesafe.ai),
et trade en continu sur un **portefeuille papier** de 1 000 USDT, visible dans une interface web
et réinitialisable à volonté.

L'idée à retenir : le code garde le contrôle (signal de prix, poids, seuils, sorties, risque) ;
Jev ne fait que des **jugements typés** sur du texte, en ~100 ms, là où un LLM classique serait
trop lent et trop cher pour du temps réel.

> Avertissement honnête : sur 3 h de prix réels, cette stratégie gagne ~+0,5 % **sans frais**
> mais perd presque tous ses allers-retours avec les 0,1 % de frais Binance par ordre. Le gain
> moyen d'un micro-trade (~0,02 %) est dix fois plus petit que les frais (0,2 % l'aller-retour).
> La simulation applique les vrais frais et affiche ce qu'ils coûtent. Aucune vraie monnaie
> n'est jamais en jeu, et rien ici n'est un conseil d'investissement.

## Setup

```bash
npm install
cp .env.example .env   # puis remplir TYPESAFE_API_KEY
```

- `TYPESAFE_API_KEY` : [console.typesafe.ai](https://console.typesafe.ai)
- `BINANCE_TESTNET_KEY` / `SECRET` (optionnel, pour `--live`) :
  [testnet.binance.vision](https://testnet.binance.vision), login GitHub, solde fictif.

## Commandes

```bash
npm start             # bot + interface sur http://localhost:3210
npm start -- --live   # idem, chaque ordre papier est aussi envoyé au testnet Binance
FEE=0 npm start       # voir la stratégie brute, sans frais
npm test
npm run typecheck
```

## Interface

- **Vitesse** : Pause, Lent (10 s), Normal (2 s), Rapide (1 s). C'est la cadence à laquelle le bot
  prend ses décisions ; les prix, eux, arrivent toujours chaque seconde.
- **Portefeuille** : valeur en direct, gain/perte, cash, positions avec leur prix d'entrée,
  nombre d'allers-retours, taux de réussite, frais payés, et courbe de valeur (verte au-dessus
  du capital de départ, rouge en dessous).
- **Cours** : chandeliers en direct, intervalles `1m 5m 15m 1h 4h 1D`, flèche ▲ à chaque achat
  et ▼ à chaque vente. Sous chaque graphique, la décision en cours : score entre −1 et +1,
  seuils d'entrée/sortie, signal micro, biais news et raison.
- **Ordres du bot** : prix, montant, résultat net de frais et raison de chaque ordre.
- **Titres jugés par Jev** : les jugements bruts ; les titres ignorés sont grisés.
- **Recommencer** remet le portefeuille à 1 000 USDT.

L'état (portefeuille + jugements) est persisté dans `data/state.json`.

## Stratégie

Chaque seconde le dernier prix de chaque symbole est échantillonné. À chaque décision :

```
micro = écart relatif EMA 10 s / EMA 60 s, borné à [-1, 1]
news  = sentiment moyen des titres pertinents, pondéré par impact × confiance × fraîcheur
score = 0,7 × micro + 0,3 × news
```

- **Entrée** si `score ≥ 0,4`, sauf risque réglementaire récent et fort, et 20 s après une vente.
- **Sortie** sur objectif (+0,3 %), stop-loss (−0,2 %), durée max (5 min) ou score `≤ −0,2`.
- Une position max par actif, ordres de 100 USDT, frais 0,1 %.

Tout se règle dans `src/config.ts`.

## Architecture

```
market.ts     bougies REST + flux WebSocket miniTicker Binance (mainnet, sans clé), EMA, signal micro
news.ts       RSS CoinDesk + Cointelegraph
brain.ts      1 requête TypeSafe par titre : asset, sentiment, material, regulatory_risk
strategy.ts   biais news (composite scoring + fraîcheur), entrées et sorties
portfolio.ts  portefeuille papier : ordres au prix réel, frais, P&L par aller-retour
broker.ts     miroir optionnel : ordres MARKET signés HMAC sur le testnet Binance
bot.ts        boucles temps réel (prix 1 s, décisions à vitesse réglable, news 60 s) + événements
server.ts     API Hono locale, flux SSE vers l'interface, fichiers statiques
public/       interface vanilla JS + TradingView lightweight-charts, sans build
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
| **Confidence gating** | `strategy.ts` | Un titre dont l'actif est peu sûr (`confidence < 0,5`) ou hors sujet est ignoré. |
| **Fraîcheur de l'état** | `strategy.ts` | Un jugement vieillit : demi-vie de 3 h sur le sentiment et le risque réglementaire. |
| **Règle séparée** | `strategy.ts` | Un risque réglementaire élevé bloque toute entrée, indépendamment du score pondéré. |
| **Jugements réutilisables** | `bot.ts` | Chaque titre n'est jugé qu'une fois, puis conservé : changer les poids ne rappelle pas le modèle. |

## Notions de simulation

- **Mainnet public** : bougies via REST (`api.binance.com`), prix en direct via WebSocket
  (`stream.binance.com`, flux `miniTicker`), sans authentification.
- **Portefeuille papier** : chaque ordre est exécuté au dernier prix réel, plafonné par le cash,
  avec 0,1 % de frais ; une vente clôture toute la position. Pas de glissement ni de carnet
  d'ordres simulés : en réel, l'exécution serait un peu moins bonne.
- **Spot Testnet** (`testnet.binance.vision`) : même API que Binance, solde fictif non
  réinitialisable. Endpoints signés : `X-MBX-APIKEY`, `timestamp`, `signature` HMAC-SHA256.

## Limites

Pas de backtest intégré, long uniquement, pas de glissement simulé. Le serveur n'écoute que sur
`127.0.0.1` et n'a pas d'authentification : ne pas l'exposer tel quel.
