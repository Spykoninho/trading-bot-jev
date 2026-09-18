# trading-bot-jev

Bot de trading crypto pédagogique : il suit les prix Binance **en temps réel**, fait juger chaque
nouvelle news par **Jev**, le modèle System One de [TypeSafe](https://typesafe.ai), et applique
une stratégie de **suivi de tendance** sur un **portefeuille papier** de 1 000 USDT, visible dans
une interface web et réinitialisable à volonté.

L'idée à retenir : le code garde le contrôle (tendance, seuils, taille des positions,
exécution) ; Jev ne fait que des **jugements typés** sur du texte, en ~100 ms par titre.

> Aucune vraie monnaie n'est jamais en jeu, et rien ici n'est un conseil d'investissement. Un
> backtest décrit le passé : il ne garantit rien pour la suite.

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
npm run history       # récupère les titres d'époque (Wayback Machine) et les fait juger par Jev
npm run backtest      # backtest 3 ans en console : avec Jev, sans news, acheter et garder
npm test
npm run typecheck
```

## Stratégie : pourquoi le suivi de tendance

Trois approches ont été comparées sur de vraies bougies Binance, frais de 0,1 % par ordre inclus :

| Approche | Résultat |
| --- | --- |
| Micro-trading (EMA 10 s / 60 s, 3 h de prix à la seconde) | ≈ +0,5 % brut, mais quasiment **aucun aller-retour gagnant** après frais : le gain moyen (~0,02 %) est dix fois plus petit que les 0,2 % de frais |
| Retour à la moyenne (RSI) et tendance en bougies 1h | mangés par les frais et les faux signaux |
| **Tendance EMA 200 en bougies 4h, bande de 1 %** | **+155 %** sur 3 ans, pire creux −32 % (acheter et garder : +62 %, pire creux −59 %) |

La règle retenue est volontairement la plus classique :

```
tendance haussière  si une bougie 4h clôture au-dessus de EMA 200 × 1,01  → acheter
tendance baissière  si une bougie 4h clôture sous      EMA 200 × 0,99  → tout vendre
entre les deux      on ne change rien (hystérésis contre les faux signaux)
```

- Le capital est réparti à parts égales entre les actifs choisis, et investi en entier quand la
  tendance est haussière ; en cash sinon.
- Trois actifs sont proposés : BTC (≈ 2,3 % de volatilité par jour), ETH (≈ 3,2 %) et **SOL**
  (≈ 4,1 %, presque deux fois le BTC). Avec SOL, le backtest passe à +193 % (pire creux −31 %),
  mais plus de volatilité n'est pas un gain garanti : la même règle finit à −5 % sur AVAX.
- Les variantes voisines (EMA 150/300, bande 0 à 2 %) donnent +127 à +161 % : le résultat ne
  dépend pas d'un réglage chanceux. Le long/short n'apporte rien de robuste.
- ~12 allers-retours par an et par actif, dont seulement un quart de gagnants : le suivi de
  tendance perd souvent un peu et gagne rarement beaucoup. En marché baissier il ne gagne pas,
  il évite surtout de perdre (−4 % la dernière année contre −40 % pour acheter et garder).

**Rôle de Jev** : le biais news décale les deux seuils d'au plus ±0,5 % (news positives :
entrée plus tôt, sortie plus tard), et un risque réglementaire récent et fort bloque tout achat.

### Avec ou sans TypeSafe : la mesure

`npm run history` retrouve les titres d'époque dans les captures des flux RSS CoinDesk et
Cointelegraph de la Wayback Machine (27 535 titres, 850 jours couverts sur 1 028), les fait
juger par Jev avec les mêmes questions que le direct (≈ 0,8 $ de crédits, 20 min), puis le
backtest les rejoue sans regard vers le futur : à chaque décision, seuls les titres déjà parus
dans les 24 h sont visibles. Résultat sur BTC + ETH + SOL, 3 ans, frais inclus :

| Variante | Rendement | Pire creux | Allers-retours |
| --- | --- | --- | --- |
| Stratégie **avec Jev** | **+196,6 %** | −31,0 % | 135 |
| Stratégie sans news | +193,4 % | −31,3 % | 122 |
| Acheter et garder | +68,2 % | −64,6 % | – |

Lecture honnête : l'apport est **positif mais faible** (+3 points), et il vient surtout du
décalage des seuils (+2,3) plus que du veto réglementaire (+0,8). Il grandit quand on donne plus
de poids aux news (jusqu'à +13 points avec un décalage de 2 %, puis il se dégrade à 3 %), mais il
n'est pas homogène : −2,8 points sur BTC seul, +0,6 sur ETH, +8,7 sur SOL. Sur ~130 ordres, un
tel écart reste compatible avec du bruit. Conclusion : sur une stratégie lente pilotée par le
prix, les titres de presse changent peu la décision ; Jev y sert de garde-fou et de contexte
lisible, pas de moteur de performance. Deux limites de la mesure : on ne juge que le titre, pas
l'article, et un modèle entraîné après coup peut connaître la suite de certains événements.

Tout se règle dans `src/config.ts`.

### Et réagir aux news elles-mêmes ? L'étude d'événements

`npm run study` prend les 1 201 titres que Jev juge à fort impact (`material ≥ 0,7`,
`|sentiment| ≥ 0,5`), autant de titres anodins comme témoin, et mesure le prix à la minute autour
de chaque parution, dans le sens prédit par Jev, avec une entrée réaliste 2 min après la parution :

| | Heure **avant** la parution | +15 min | +1 h | « Suivre Jev 1 h », frais inclus |
| --- | --- | --- | --- | --- |
| Fort impact selon Jev | **+0,057 %** (t = 2,5) | +0,018 % (t = 1,9) | +0,032 % (t = 1,8) | **−0,17 % par ordre**, 33 % gagnants |
| Témoin | +0,015 % | 0,000 % | −0,010 % | −0,21 % par ordre |

Jev lit juste : le prix a bien bougé dans son sens, mais **avant** la parution (jusqu'à +0,15 %
sur les titres les plus forts, et des cas comme « Ether Jumps 10 % After… », déjà +7,6 % quand
l'article sort). Après la parution, il reste une dérive six fois plus petite que les frais, et
les titres « forts » ne sont pas suivis de mouvements plus amples que les titres anodins (0,43 %
en moyenne sur 1 h dans les deux cas). L'effet est aussi faible sur 2026 que sur 2023-2024, donc
ce n'est pas la mémoire du modèle qui le fabrique. Conclusion : le goulot n'est pas Jev (~100 ms)
mais la **source** ; un article de presse décrit un mouvement déjà fait. Une stratégie
événementielle n'a de sens qu'avec des sources primaires (annonces d'exchanges, communiqués
officiels, comptes X), et ne peut se valider qu'en papier, en direct.

### Le test en direct sur sources primaires

C'est ce que fait maintenant le bot en continu. En plus de la presse (sondée toutes les 60 s), il
sonde des **sources primaires**, c'est-à-dire l'émetteur de l'événement lui-même : annonces
officielles Binance (listings, retraits), communiqués de la SEC et de la Fed, posts Truth Social
de Trump (via le miroir RSS trumpstruth.org), toutes les 30 à 60 s. Jev juge chaque nouveauté ;
ses questions couvrent aussi la macro et la politique (un post sur des droits de douane compte
comme « marché crypto dans son ensemble »).

Chaque titre pertinent vu moins de 5 minutes après sa parution devient un **événement suivi** :
prix temps réel à la détection, retard par rapport à la parution, sens prédit par Jev, puis prix
relevé à +5 min, +15 min, +1 h et +4 h (bougie 1 min clôturée, donc robuste aux redémarrages).
Le panneau « Test en direct » affiche le tableau et le rendement moyen dans le sens de Jev, fort
impact contre le reste. Rien n'est recalculé après coup : ni mémoire du modèle, ni connaissance
du futur. Il faut laisser tourner quelques semaines avant d'en tirer une conclusion, et aucune
stratégie ne trade sur ces événements tant que la mesure n'est pas faite.

## Interface

- **Portefeuille en direct** : valeur à la seconde, gain/perte, cash, positions avec prix
  d'entrée, frais payés, courbe de valeur (verte au-dessus du capital de départ, rouge en dessous).
- **Cours** : chandeliers en direct, intervalles `1m 5m 15m 1h 4h 1D`, flèches ▲▼ sur les ordres,
  seuils d'achat et de vente en pointillés. Sous chaque graphique : tendance, position du prix
  par rapport à l'EMA, biais news et raison de la décision.
- **Replay** : la stratégie rejouée sur 3 ans d'historique réel, contre « acheter et garder »,
  avec vitesse réglable (Pause, ×1, ×5, ×25, Fin). Même fonction `decide` que le direct.
- **Test en direct** : les titres captés à chaud, avec leur retard, l'avis de Jev et l'évolution
  du prix à +5 min, +15 min, +1 h et +4 h.
- **Ordres du bot** et **Titres jugés par Jev** (les titres ignorés sont grisés).
- **Nouvelle simulation** : tu coches les actifs sur lesquels le bot peut investir (BTC, ETH,
  SOL), le portefeuille repart à 1 000 USDT et le bot se réaligne aussitôt sur la tendance. Les
  actifs non retenus restent affichés, grisés, et le replay suit la sélection.

L'état est persisté dans `data/` : `state.json` (portefeuille, jugements, titres déjà vus) et
`events.json` (événements suivis).

## Architecture

```
market.ts       bougies REST (+ historique paginé) et flux WebSocket miniTicker Binance, sans clé
news.ts         sources sondées : presse (RSS CoinDesk, Cointelegraph) et primaires (Binance, SEC, Fed, Trump)
events.ts       test en direct : événements suivis, relevés de prix à échéance, bilan par niveau d'impact
brain.ts        1 requête TypeSafe par titre : asset, sentiment, material, regulatory_risk
strategy.ts     biais news, tendance EMA avec hystérésis, décision BUY / SELL / HOLD
portfolio.ts    portefeuille papier : ordres au prix réel, frais, P&L par aller-retour
backtest.ts     rejoue `decide` bougie par bougie : décision à la clôture, exécution à l'ouverture suivante
history.ts      titres d'époque : captures RSS de la Wayback Machine, jugées par Jev, dans data/history.json
broker.ts       miroir optionnel : ordres MARKET signés HMAC sur le testnet Binance
bot.ts          boucles (prix 1 s, bougies 60 s, une cadence par source), suivi d'événements, cache du backtest
server.ts       API Hono locale, flux SSE vers l'interface, fichiers statiques
public/         interface vanilla JS + TradingView lightweight-charts, sans build
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
| **Règle séparée** | `strategy.ts` | Un risque réglementaire élevé bloque toute entrée, indépendamment de la tendance. |
| **Jugements réutilisables** | `bot.ts` | Chaque titre n'est jugé qu'une fois, puis conservé : changer les poids ne rappelle pas le modèle. |

## Notions de simulation

- **Mainnet public** : bougies via REST (`api.binance.com`), prix en direct via WebSocket
  (`stream.binance.com`, flux `miniTicker`), sans authentification.
- **Portefeuille papier** : chaque ordre est exécuté au dernier prix réel, plafonné par le cash,
  avec 0,1 % de frais ; une vente clôture toute la position. Pas de glissement simulé.
- **Décision sur bougies clôturées** : la bougie en cours n'est jamais utilisée, en direct comme
  en backtest, pour ne pas réagir à un mouvement qui s'efface avant la clôture.
- **Spot Testnet** (`testnet.binance.vision`) : même API que Binance, solde fictif non
  réinitialisable. Endpoints signés : `X-MBX-APIKEY`, `timestamp`, `signature` HMAC-SHA256.

## Limites

Long uniquement, deux actifs très corrélés, pas de glissement simulé, 3 ans d'historique
seulement (un cycle haussier puis baissier). Le serveur n'écoute que sur `127.0.0.1` et n'a pas
d'authentification : ne pas l'exposer tel quel.
