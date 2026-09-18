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

## v6 — mesure de l'apport de Jev sur l'historique

- Source des titres d'époque : captures RSS CoinDesk/Cointelegraph de la Wayback Machine (CDX,
  une capture par jour, suffixe `id_` pour le XML brut). API d'actualités écartées (clé requise),
  sitemap Cointelegraph écarté (dates `lastmod` faussées par une migration du site).
- `history.ts` : collecte + jugement Jev reprenables, `data/history.json` (non versionné).
- `backtest(history, cfg, judgments)` : fenêtre glissante de 24 h de titres parus avant chaque
  décision, test anti-regard-vers-le-futur. `GET /api/backtest` renvoie `plain`, `jev`, `hold`
  et la couverture ; le replay trace les trois courbes.
- Résultat : +196,6 % avec Jev contre +193,4 % sans ; effet faible, non homogène par actif.
  `newsTilt` laissé à 0,5 % pour ne pas sur-ajuster sur la même période.

## v7 — étude d'événements (faut-il trader les news ?)

- `event-study.ts` (`npm run study`) : pour chaque titre à fort impact selon Jev et un groupe
  témoin, rendement signé à la minute avant/après la parution, entrée à +2 min, dédoublonnage
  par actif/sens sur 30 min, prix mis en cache dans `data/event-klines.json`.
- Résultat : le mouvement précède l'article (+0,057 % sur l'heure avant, t = 2,5) ; dérive
  résiduelle +0,03 % à 1 h contre 0,2 % de frais ; amplitude post-parution identique au témoin.
  Les flux RSS de presse sont trop lents pour une stratégie événementielle ; piste suivante :
  sources primaires + validation en papier, en direct.

## v8 — sources primaires et test en direct

- `news.ts` : `SOURCES` = presse (CoinDesk, Cointelegraph, 60 s) + primaires (annonces Binance
  catalogues 48/161, SEC, Fed, Trump via trumpstruth.org, 30–60 s). CFTC et Coinbase bloquent les
  robots ; Maison-Blanche écartée (bruit). `state.seen` (3 000 titres) évite de rejuger un titre.
- Questions Jev élargies : `crypto` inclut les événements macro/politiques qui bougent tout le marché.
- `events.ts` : `track` (titre vu < 5 min après parution, prix temps réel, retard, sens),
  `dueReadings` (relevés à +5/+15/+60/+240 min sur bougie 1 min clôturée), `scoreboard`
  (rendement moyen dans le sens de Jev, fort impact vs autres). Persisté dans `data/events.json`.
- Aucune stratégie ne trade sur ces événements : on mesure d'abord, en conditions réelles.

## v9 — replay et étude étendus aux sources primaires

- `history.ts` : `collectPrimary` (index JSON de la Fed avec conversion heure de New York → UTC,
  archive CNN des posts Truth Social, pagination de l'API Binance) + captures Wayback du flux SEC ;
  un index Wayback indisponible saute la source au lieu d'arrêter la collecte. 47 618 titres jugés.
- Replay : +199,3 % avec Jev (toutes sources) contre +194,8 % sans.
- `event-study.ts` sépare presse et sources primaires : aucune dérive exploitable dans le sens
  de Jev sur 117 événements primaires ; cause principale identifiée = texte tronqué ou titre
  sans contenu (post du 9 avril 2025, communiqués FOMC). Le direct juge désormais le texte du
  post Truth Social (`parseRss(..., body = true)`), pas le titre RSS coupé à ~90 caractères.
- Piste suivante : texte complet et questions propres à chaque source, validés par le test en direct.
