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

## v2 — interface web

- **Portefeuille papier** (`portfolio.ts`) : 1 000 USDT, ordres au prix réel, frais 0,1 %,
  persisté dans `data/state.json`, réinitialisable. Le testnet Binance devient un miroir
  optionnel (`--live`) car son solde ne peut pas être remis à zéro.
- **`bot.ts`** : état partagé ; `tick` (prix + équité, 1/min, sans Jev) et `cycle` (Jev).
- **`server.ts`** : Hono sur `127.0.0.1`, protection CSRF ; `GET /api/state`,
  `GET /api/candles/:symbol`, `POST /api/cycle`, `POST /api/reset`.
- **`public/`** : vanilla JS + Chart.js servi depuis `node_modules`, palette dataviz de
  référence, clair/sombre, titres RSS insérés en nœuds texte uniquement.

## v3 — micro-trading temps réel

- **Prix** : WebSocket Binance `miniTicker`, échantillonné chaque seconde dans un tampon de 10 min.
- **Signal micro** (code) : écart EMA 10 s / EMA 60 s saturé à ±0,02 % ; sorties sur objectif,
  stop-loss, durée max ou retournement. Calibré sur 3 h de klines 1 s réelles : avantage brut
  ≈ +0,5 %, mais négatif avec 0,1 % de frais par ordre.
- **Jev** : ne juge que les titres nouveaux (poll RSS 60 s) ; biais news avec demi-vie de 3 h.
- **Temps réel** : `bot.ts` émet `tick` (1 s), `trade`, `news`, `reset` ; `server.ts` les pousse
  en SSE. Vitesse de décision réglable (`POST /api/speed/:ms`).
- **UI** : thème sombre, chandeliers `lightweight-charts`, intervalles 1m→1D, bougie en cours
  animée par le flux, courbe d'équité en série baseline.

## v4 — suivi de tendance choisi par backtest

- Recherche sur 3 ans de bougies réelles (frais 0,1 %, découpage en 3 années) : le micro-trading
  et le RSI perdent après frais ; le suivi de tendance 4h/1j bat « acheter et garder ».
- Retenu : EMA 200 en 4h avec bande d'hystérésis de 1 %, long uniquement, capital réparti à
  parts égales. +155 % contre +62 %, pire creux −32 % contre −59 %. Plateau robuste (EMA 150–300,
  bande 0–2 % : +127 à +161 %). Long/short et vote de signaux écartés (pas mieux, plus de rotation).
- `backtest.ts` rejoue la même fonction `decide` que le direct : décision à la clôture,
  exécution à l'ouverture suivante. `GET /api/backtest` (cache 1 h) alimente le replay animé.
- Jev : biais news = décalage des seuils d'au plus ±0,5 %, veto réglementaire conservé. Non backtesté.
- Le direct ne décide que sur bougies clôturées (rafraîchies chaque minute) ; au démarrage et
  après un reset, le bot s'aligne immédiatement sur la tendance courante.

## v5 — actif volatil au choix

- Ajout de SOLUSDT (volatilité ≈ 1,8× celle du BTC, liquide, bien couvert par la presse) et de
  l'option `SOL` dans la question `asset` de Jev. La liste des actifs devient une constante de
  `config.ts` (plus de variable `SYMBOLS`) car elle est liée aux options de la question.
- `state.active` : actifs retenus pour la simulation, choisis dans une fenêtre « Nouvelle
  simulation » (`POST /api/reset {symbols}`), persistés ; capital réparti entre eux.
- Les tendances sont calculées pour tous les actifs, le bot n'agit que sur les actifs retenus ;
  le backtest/replay est mis en cache par sélection.
