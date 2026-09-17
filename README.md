# trading-bot-jev

Bot de trading crypto pédagogique : il lit le marché **réel** sur Binance, fait juger les
news par **Jev**, le modèle System One de [TypeSafe](https://typesafe.ai), et passe des ordres
**simulés** sur le Binance Spot Testnet.

L'idée à retenir : le code garde le contrôle (indicateurs, poids, seuils, risque, exécution) ;
Jev ne fait que des **jugements typés** sur du texte, là où du code classique ne sait pas lire.

## Setup

```bash
npm install
cp .env.example .env   # puis remplir les clés
```

- `TYPESAFE_API_KEY` : [console.typesafe.ai](https://console.typesafe.ai)
- `BINANCE_TESTNET_KEY` / `SECRET` : [testnet.binance.vision](https://testnet.binance.vision),
  login GitHub, solde fictif offert. Aucune vraie monnaie n'est en jeu.

## Commandes

```bash
npm start -- --once          # un cycle, dry-run : décisions affichées, aucun ordre
npm start -- --once --live   # un cycle avec ordres MARKET sur le testnet
npm start -- --live          # boucle toutes les INTERVAL_MIN minutes
npm test                     # vitest
npm run typecheck
```

Chaque cycle écrit `logs/<date>.json` avec les données de marché, les jugements bruts de Jev
et les décisions.

## Cycle

```
market.ts   bougies 1h Binance mainnet (sans clé) → prix, SMA 24, signal tech ∈ [-1, 1]
news.ts     RSS CoinDesk + Cointelegraph → 20 titres
brain.ts    1 requête TypeSafe par titre : asset, sentiment, material, regulatory_risk
strategy.ts composite scoring + confidence gating → BUY / SELL / HOLD
broker.ts   ordres MARKET signés HMAC sur le testnet
index.ts    orchestration, tables console, journal JSON
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
| **Jugements réutilisables** | `logs/` | Les réponses brutes sont conservées : changer les poids ne nécessite pas de rappeler le modèle. |

## Notions Binance

- **Mainnet public** (`api.binance.com`) : données de marché réelles, sans authentification.
- **Spot Testnet** (`testnet.binance.vision`) : même API, solde fictif, prix proches du réel
  mais liquidité faible. Les endpoints signés exigent `X-MBX-APIKEY`, un `timestamp` et une
  `signature` HMAC-SHA256 de la query string.
- **Ordre `MARKET` + `quoteOrderQty`** : on donne un montant en USDT, Binance calcule la
  quantité d'actif. Pas besoin de gérer les `LOT_SIZE`.

## Limites v1

Pas de backtest, pas de stop-loss, un seul flux de décision. Les seuils (`config.ts`) sont des
points de départ à évaluer sur les logs, pas des vérités.
