# trading-bot-jev

## 1. Le projet

Un bot de trading crypto construit pour répondre à une question : **à quoi sert Jev**, le modèle
« System One » de [TypeSafe](https://typesafe.ai), et **apporte-t-il quelque chose par rapport à
un algorithme seul ?**

Ce n'est pas du micro-trading, mais un **suiveur de tendance de moyen terme** — une moyenne mobile
sur bougies de 4 h, dont la mémoire couvre environ 33 jours — auquel on a greffé une lecture des
news en temps réel. Le bot suit les prix Bitvavo, fait lire l'actualité à Jev, décide avec un
algorithme et exécute sur un portefeuille papier de 1 000 USDC, ou sur un vrai compte à la demande,
le tout affiché dans une interface web.

Par défaut aucune vraie monnaie n'est en jeu, et **rien ici n'est un conseil d'investissement** :
trader pour de vrai peut faire perdre tout ou partie du capital engagé.

## 2. Démarrage rapide

Node 20.12 ou plus récent, et une clé TypeSafe : sans elle le bot refuse de démarrer, même en
papier.

```bash
npm install
cp .env.example .env   # puis remplir TYPESAFE_API_KEY (console.typesafe.ai)
npm start              # bot + interface sur http://localhost:3210
```

- `npm run backtest` compare sans news, biais seul, veto seul, biais + veto et acheter et garder ;
  `-- --fees` rejoue à 0,05 / 0,15 / 0,25 / 0,40 % de frais.
- `npm run history` reconstitue les publications des 3 dernières années et les fait juger par Jev
  (≈ 2,50 $).
- `npm run study` lance l'étude d'événements.
- `npm test` et `npm run typecheck`.

L'interface offre en plus un **replay** de l'historique et un **test en direct**, qui suit le prix
des publications fraîches.

## 3. Comment il fonctionne

**Jev lit, l'algorithme décide** : Jev rend en ~100 ms un jugement typé — « parle du BTC (0,97) »,
« soutient la crypto (0,93) » — sans jamais prédire un prix ; l'algorithme, lui, calcule la
tendance, fixe les seuils, dimensionne et exécute.

**La règle de tendance**, sur bougies de 4 h. L'EMA (*exponential moving average* : une moyenne des
clôtures passées qui pèse davantage les récentes) sur 200 bougies résume environ 33 jours.

```
une bougie clôture au-dessus de EMA 200 × 1,01  → acheter
une bougie clôture sous      EMA 200 × 0,99  → tout vendre
entre les deux                                 → attendre
```

Le capital va à parts égales de l'equity courante aux actifs choisis au lancement (BTC, ETH, SOL),
hors une réserve de 10 %, vrai plancher de cash.

**Ce que fait Jev.** Les publications de la presse crypto, de Trump, de la Fed, de la SEC et des
annonces Binance sont jugées une par une en questions typées : actif concerné, sentiment,
matérialité, risque réglementaire. Le code n'en tire que deux effets : un **biais news**
qui décale les deux seuils d'au plus **±0,5 %**, et un **veto réglementaire** sur les achats.

**Circuit immédiat.** Une bougie de 4 h est trop lente pour une news : `EVENT_RULES` (`config.ts`)
agit dès la détection, avec une seule règle — un post de Trump jugé « soutien à la crypto » à 0,8
ou plus déclenche l'achat de 10 % de l'equity, revendu 4 h plus tard, sur la réserve. Elle ne
repose que sur 13 événements : **active en papier, désactivée avec `--real`** sauf `--events`.

**Pourquoi si peu d'opérations.** 14 à 16 allers-retours par an et par actif, et c'est voulu :
chacun coûte deux fois les frais plus le glissement. Le gain vient de quelques longues tendances
tenues jusqu'au bout.

### Qui fait quoi

```
market.ts, news.ts                        prix Bitvavo et sources d'actualité
brain.ts, strategy.ts                     jugements de Jev, biais news, tendance, décision
portfolio.ts, broker.ts                   portefeuille papier et exécution réelle
events.ts                                 circuit immédiat et test en direct
backtest.ts, history.ts, event-study.ts   mesures sur l'historique
bot.ts, server.ts, pool.ts, public/       boucles, API locale + SSE, interface
```

L'état est persisté dans `data/`, non versionné. Questions posées à Jev, seuils, sources et journal
des choix : [`docs/design.md`](docs/design.md).

## 4. Résultats

Backtest sur bougies Bitvavo réelles, **configuration par défaut** : BTC-USDC + ETH-USDC + SOL-USDC
en 4 h, du 29/09/2024 au 19/09/2026 (≈ 1,97 an, tout l'historique), frais 0,05 %, glissement
4 points de base, publications d'époque rejouées sans regard vers le futur.

| Variante | Rendement | Pire creux | Sharpe | Allers-retours | Frais USDC |
| --- | --- | --- | --- | --- | --- |
| **Sans news** | **+84,9 %** | **26,2 %** | **1,39** | **78** | **31** |
| Biais seul | +81,9 % | 26,0 % | 1,35 | 85 | 33 |
| Veto seul | +85,1 % | 26,2 % | 1,39 | 78 | 31 |
| Biais + veto | +82,1 % | 26,0 % | 1,35 | 85 | 33 |
| Acheter et garder | −2,5 % | 63,3 % | 0,19 | 1 | 0,50 |

Le **pire creux** est la plus forte baisse depuis un sommet ; le **Sharpe** rapporte le rendement à
la volatilité ; ce sont des **rendements en dollars**.

La référence longue, seule à couvrir ~3 ans, est l'ancienne série en EUR à 0,25 % de frais
(2,82 ans) : **+142,7 %** contre **+68,3 %** en acheter-et-garder. Sur la période commune aux deux
devises, l'USDC fait **+82,1 %** contre **+58,1 %** en EUR, pour **33 contre 169** de frais — le
changement le plus rentable de ce projet ; l'avance fond quand le frottement monte
(`npm run backtest -- --fees`).

**Profil des opérations** : ≈ un quart de gagnantes (23,5 % sur 85), médiane négative (−2,41 %), et
les 5 meilleures font 206 % du gain cumulé. Perdre trois fois sur quatre et gagner quand même est
normal en suivi de tendance, mais demande de tenir les pertes.

Trois conclusions, sans fard :

- **La tendance réduit le risque** : elle divise le pire creux par plus de deux et double le
  Sharpe — sur une période plate, qui avantage une stratégie en cash ~47 % du temps.
- **Jev n'apporte rien de mesurable sur les prix.** L'écart avec « sans news » a été mesuré trois
  fois, pour trois valeurs — **−2,8**, **−2,1**, **+4,9** points selon la devise et les frais : le
  signe change, c'est du bruit. Il lit et trie en revanche **49 496 textes pour ≈ 2,50 $**, là où
  un LLM classique serait plus lent et plus cher.
- **La règle Trump est une hypothèse, pas un résultat** : n = 13.

**L'étude d'événements** dit la même chose. Réagir à la presse ne marche pas : sur 1 201 titres à
fort impact, le prix a déjà bougé *avant* la parution et il ne reste que +0,032 % à 1 h, loin sous
les frais. Lire vite ne suffit pas : Jev a classé sans erreur les 25 décisions de taux de la Fed,
mais le prix les avait déjà intégrées. Seuls les posts de soutien à la crypto de Trump ressortent,
+0,63 % à 1 h (p = 0,034) : assez pour rendre l'hypothèse testable, pas pour la valider. Détail par
groupe : [`docs/design.md`](docs/design.md).

## 5. Limites

- Une seule période de mesure, plate pour acheter-et-garder, qui commence après FTX.
- Biais de sélection : SOL a été retenu, AVAX écarté, sur la période même qui sert de mesure.
- Trois actifs corrélés à ~0,8 ne sont pas une diversification.
- Historique court en USDC : ces paires n'existent chez Bitvavo que depuis juillet 2024.
- Rendements en dollars : qui compte en euros dépend aussi de l'EUR/USD.
- Risque d'émetteur et de décrochage de l'USDC, qui avait perdu sa parité en mars 2023.
- Liquidité : le carnet USDC est ~40× moins profond que l'EUR, d'où `SLIPPAGE_BPS=4`.
- Le backtest ne couvre pas le circuit événementiel : seul le test en direct le tranchera.
- Contamination possible : le modèle, entraîné après coup, peut connaître la suite.
- Les posts de Trump passent par des agrégateurs tiers non officiels, qui peuvent disparaître.
- Fournisseur unique au SDK pré-1.0 : si l'API TypeSafe tombe, le bot continue sur la tendance.

## 6. L'utiliser en conditions réelles

L'exécution passe par **Bitvavo**, plateforme agréée MiCA ; vérifie son statut sur la liste blanche
de l'AMF avant d'y déposer de l'argent. Tout est en **USDC** : 0,05 % de frais contre 0,15 / 0,25 %
en euros, et vendre contre un stablecoin n'est pas revenir en euros, ce qui change le traitement
fiscal. L'aller-retour euros ↔ USDC se fait à la main sur `USDC-EUR`, **pas par le bot**.

**Le compte papier, mode par défaut.** `npm start` tient un portefeuille fictif dans
`data/state.json` : prix réels et en direct, frais et glissement simulés, mais **aucun ordre envoyé
nulle part** et aucune clé d'exchange requise. C'est le mode dans lequel tout a été mesuré ;
laisse-le tourner d'abord.

**Ce que fait `--real`.** Le papier reste le cerveau, et chaque ordre papier est recopié en ordre
au marché (`broker.ts`). Le bot retient la **quantité exacte** reçue à l'achat et ne revend que
celle-là, sans toucher au reste du compte ; le solde est réconcilié au démarrage puis toutes les
heures, un écart levant un bandeau rouge ; aucun ordre n'est envoyé sur un prix de plus de 30 s.
Autres garde-fous : [`docs/design.md`](docs/design.md).

**Pourquoi il n'y a pas de testnet.** Un *testnet* est une copie de la plateforme en argent
factice : il n'y en a pas ici, et celui d'une autre plateforme ne testerait pas cet adaptateur. La
répétition se fait donc en réel avec un `START_CASH` très petit, au-dessus des planchers :
**5 USDC** par ordre, 10 côté portefeuille papier.

**Les notifications.** Ce que le bot journalise remonte dans l'interface : toasts, cloche à
compteur, bandeau rouge quand une intervention s'impose (liste des alertes dans
[`docs/design.md`](docs/design.md)).

### Mise en place

1. **Un compte dédié**, avec le seul capital confié au bot ; dépose des euros par virement SEPA,
   puis convertis-les en USDC sur `USDC-EUR`.
2. **Une clé API restreinte** : trader seulement, sans droit de retrait, IP en liste blanche. À
   dire honnêtement : **la plateforme n'expose pas les droits d'une clé par API**, le bot **ne peut
   donc pas le vérifier à ta place**.
3. **Déclare le capital** : `START_CASH=<montant en USDC>`, que le bot ne dépassera jamais.
4. **Lance** `npm start -- --real`, puis « Nouvelle simulation » et coche les actifs. Le bot
   s'aligne aussitôt sur la tendance : haussière, il achète.
5. **Laisse tourner en continu** : arrêté il ne décide plus rien, relancé il applique la décision
   en retard.

### Configuration (`.env`)

| Variable | Rôle |
| --- | --- |
| `TYPESAFE_API_KEY` | Obligatoire, même en papier |
| `QUOTE` | Devise de cotation, `USDC` par défaut |
| `BASES` | Actifs proposés, `BTC,ETH,SOL` par défaut ; chacun doit être une option de la question `asset` |
| `FEE` | Frais par ordre, `0.0005` par défaut |
| `SLIPPAGE_BPS` | Glissement à l'exécution, `4` points de base |
| `START_CASH` | Capital confié au bot, **en USDC** ; obligatoire avec `--real` |
| `BACKTEST_YEARS` | Profondeur d'historique du backtest et du replay, `3` par défaut |
| `PORT` | Port de l'interface, `3210` par défaut |
| `BITVAVO_API_KEY` / `BITVAVO_API_SECRET` | Clés d'exécution, `--real` uniquement |
| `BITVAVO_OPERATOR_ID` | Donneur d'ordre, entier exigé sur chaque ordre |

Variante en euros : `QUOTE=EUR`, `FEE=0.0025`, `SLIPPAGE_BPS=2`, en payant 5 fois plus de frais.
Un état enregistré dans une autre devise est archivé, pas repris.

### Fiscalité (France, à vérifier auprès d'un professionnel)

- Seule la cession contre une monnaie ayant cours légal est imposable (art. 150 VH bis du CGI) ; le
  bot revenant en USDC, l'impôt serait **reporté, pas supprimé**, dû à la conversion en euros.
- **À ne pas tenir pour acquis** : l'USDC est un jeton de monnaie électronique au sens de MiCA et
  aucune position de l'administration ne confirme ce sursis — interprétation courante, à faire
  valider par un professionnel.
- Avec `QUOTE=EUR`, chaque vente est une cession : **formulaire 2086**, ~130 lignes sur trois ans.
- **3916-bis** dans tous les cas, le compte étant ouvert à l'étranger : l'omission coûte 750 €.
- **DAC8** depuis le 01/01/2026 : les plateformes transmettent comptes et opérations au fisc.

## 7. Pistes, non promises

- **Règle « listing spot »** : le signal existe (`spot_listing`), reste à le mesurer avec
  `npm run study`.
- **Sorties d'urgence sur hack**, purement numériques, sans IA.
- **CPI et emploi américains** : demanderaient une *surprise contre consensus* qu'on n'a pas.
- **Flux ETF** et **funding rate des perpétuels**, gratuits et peu corrélés à l'EMA.
- **Plafond de poids par ligne** (~40 %) : une position a atteint 44,8 % du portefeuille.
- **Coupe-circuit de creux**, **calibration de `material` par déciles**, **mesure de
  contamination** en rejugeant des publications privées de leur date.

Ce qui a été essayé puis écarté est dans [`docs/design.md`](docs/design.md).

## 8. Licence, sécurité, intégration continue

Licence MIT (`LICENSE`) ; pour signaler une faille, `SECURITY.md`, jamais d'issue publique ;
`npm test` et `npm run typecheck` tournent à chaque push et chaque PR. Le serveur web n'écoute que
sur `127.0.0.1`, sans authentification : à distance, passe par un tunnel SSH.
