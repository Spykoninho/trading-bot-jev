# Design v1 — trading-bot-jev

Bot pédagogique : montrer concrètement ce que TypeSafe (modèle Jev) apporte dans un
bot de trading. Le code garde le contrôle (indicateurs, risque, exécution) ; Jev ne
fait que des jugements sémantiques typés sur les news.

## Environnement

- **Données de marché réelles** : API publique Binance mainnet (`api.binance.com`),
  sans clé. Bougies 1h et ticker 24h sur `BTCUSDT` et `ETHUSDT`.
- **Exécution simulée** : Binance Spot Testnet (`testnet.binance.vision`), clés
  gratuites via login GitHub, solde fictif. Ordres `MARKET` signés HMAC-SHA256.
- **News** : flux RSS CoinDesk + Cointelegraph, 20 derniers titres.

## Cycle (`npm start`, toutes les `INTERVAL_MIN` minutes, ou `--once`)

1. `market` : bougies → prix, variation 24h, SMA 24 → signal technique ∈ [-1, 1].
2. `news` : titres RSS dédupliqués.
3. `brain` : pour chaque titre, **une** requête `systemOne` (fan-out) avec :
   - `asset` Choice : `BTC` / `ETH` / `crypto` / `unrelated`
   - `sentiment` Score 5 niveaux décrits par des situations concrètes
   - `material` Noul : la news peut bouger le marché vs bruit
   - `regulatory_risk` Noul
4. `strategy` (code pur) :
   - score news par actif = Σ (sentiment normalisé × material × confidence) / Σ poids
     (composite scoring) ; les titres `unrelated` ou à faible confiance sont ignorés.
   - score final = 0.6 × news + 0.4 × technique ; seuils → `BUY` / `SELL` / `HOLD`.
   - confidence-gated : moins de N titres pertinents ou confiance moyenne basse → `HOLD`.
   - `regulatory_risk` élevé bloque tout `BUY` (règle « violation grave » séparée).
5. `execution` : taille fixe `ORDER_USDT`, une position max par actif, `--dry-run`
   par défaut (aucun ordre).
6. `journal` : table console + JSON des jugements bruts dans `logs/` (réutilisables
   pour changer les poids sans rappeler le modèle).

## Fichiers

```
src/
  config.ts        env + seuils
  market.ts        Binance mainnet (klines, ticker) + indicateurs
  news.ts          RSS → titres
  brain.ts         questions TypeSafe + appel systemOne
  strategy.ts      composite scoring, gating, décision
  broker.ts        Binance testnet : compte, ordres signés
  index.ts         boucle
tests/             strategy, market indicators, broker signature (vitest)
```

## Hors scope v1

Backtest, stop-loss, WebSocket temps réel, plusieurs stratégies, UI.
