# Journal des choix

But du projet : comprendre comment fonctionne Jev (TypeSafe) et mesurer s'il est utile dans un
bot de trading, par rapport à un algorithme seul. Chaque entrée dit ce qui a été essayé, ce que
les données ont montré, et ce qui a été gardé.

## 1. Environnement

- Données réelles : API publique Binance (bougies REST, prix WebSocket), sans clé.
- Simulation : portefeuille papier local de 1 000 USDT, frais de 0,1 %, réinitialisable. Le
  testnet Binance n'est qu'un miroir optionnel (`--live`) : son solde ne peut pas être remis à zéro.
- Alpaca (actions) écarté : inscription requise, marché fermé la nuit et le week-end.

## 2. Stratégie de prix

| Essai | Résultat sur données réelles, frais inclus | Décision |
| --- | --- | --- |
| Micro-trading, EMA 10 s / 60 s | ≈ +0,5 % brut sur 3 h, presque aucun aller-retour gagnant après frais | Abandonné |
| Retour à la moyenne (RSI), tendance en 1 h | Mangés par les frais et les faux signaux | Abandonné |
| Long/short, vote de plusieurs signaux | Pas mieux, plus de rotation | Abandonné |
| **EMA 200 en 4 h, bande d'hystérésis de 1 %** | +155 % sur 3 ans (BTC + ETH), creux −32 %, contre +62 % / −59 % | **Retenu** |

Plateau robuste : EMA 150 à 300 et bande 0 à 2 % donnent +127 à +161 %. SOL ajouté comme actif
plus volatil (≈ 1,8 × le BTC) : +193 % à trois actifs. AVAX, aussi volatil, finit à −5 %.

Le direct et le backtest partagent la même fonction `decide`, sur bougies clôturées uniquement :
décision à la clôture, exécution à l'ouverture suivante.

## 3. Rôle de Jev

- Questions génériques par publication : `asset` (Choice), `sentiment` (Score), `material` et
  `regulatory_risk` (Noul). Le code en tire un biais news par actif (pondéré par impact,
  confiance et fraîcheur, demi-vie de 3 h) qui décale les seuils d'au plus ±0,5 %, et un veto
  réglementaire sur les achats.
- Questions propres à chaque source primaire (`SOURCE_RULES`), posées dans la même requête, et
  composées en code : décision de taux de la Fed ; escalade, détente, soutien crypto et escalade
  militaire pour Trump (signaux opposés = neutre) ; portée pour la SEC ; type pour Binance.
- Texte complet quand il existe : post entier, page du communiqué de la Fed, résumé RSS de la SEC.

## 4. Mesures

**Avec ou sans Jev, sur 3 ans** (`npm run history`, puis replay). Publications d'époque : captures
RSS de la Wayback Machine (CoinDesk, Cointelegraph, SEC), index horodaté de la Fed, archive
publique des posts de Trump, API Binance paginée. Écartés : API d'actualités à clé, GDELT (bloque
cette adresse IP), sitemap Cointelegraph (dates faussées par une migration du site).

| Version des jugements | Avec Jev | Sans news |
| --- | --- | --- |
| Presse, titres seuls | +196,6 % | +193,4 % |
| + sources primaires, titres seuls | +199,3 % | +194,8 % |
| + texte complet et questions par source | +204,5 % | +194,8 % |

`newsTilt` laissé à 0,5 % : un réglage à 2 % donnerait +13 points, mais ce serait s'ajuster sur
la période même qu'on mesure.

**Étude d'événements** (`npm run study`), entrée 2 min après la publication, dans le sens de Jev :
presse à fort impact, +0,057 % sur l'heure *avant* (t = 2,5) puis +0,03 % à 1 h, soit −0,17 % par
ordre après frais. Sources primaires : décisions de taux de la Fed −0,48 % à 1 h (baisses
attendues, déjà dans les prix), escalades commerciales et militaires de Trump sans effet, soutien
crypto de Trump +0,63 % à 1 h (n = 13, une dizaine de sous-groupes testés).

**Test en direct** (`events.ts`) : publications vues moins de 5 min après leur parution, prix à la
détection puis à +5 min, +15 min, +1 h, +4 h. Seule mesure à l'abri de la mémoire du modèle, dont
la version actuelle est sortie le 10 septembre 2026.

## 5. Circuit immédiat

Une bougie de 4 h est trop lente pour une news. `eventRules` déclenche un achat dès la détection,
dans un livre de positions séparé (`event:<symbole>`), sur une réserve de 10 % du capital, avec
sortie programmée. Une seule règle, celle que l'étude soutient : soutien crypto de Trump ≥ 0,8,
revente après 4 h. À confirmer par le test en direct avant d'en ajouter d'autres.

## 6. Exécution sur un exchange

Le portefeuille papier reste la source de vérité de l'interface ; `--live` (testnet) et `--real`
(Binance réel) répliquent chaque ordre avec la même API, seuls l'URL et les clés changent. Le
bot retient la quantité réellement reçue à l'achat (`executedQty` moins les frais prélevés sur
l'actif) et ne revend que celle-là, arrondie vers le bas au pas `LOT_SIZE` : il ne touche jamais
au reste du compte. Garde-fous : `--real` exige des clés dédiées et `START_CASH` explicite ; une
nouvelle simulation est refusée tant que des positions sont ouvertes sur l'exchange. Validé sur
le testnet (achat puis revente exacte sur BTC et SOL), jamais exécuté en réel par le développement.

Chaque clôture de bougie consigne la décision de chaque actif, « attendre » compris (`state.waits`).

## 7. Pièges rencontrés

- Identifier une publication par son seul titre fusionnait les huit « Federal Reserve issues FOMC
  statement » annuels et aurait fait ignorer le suivant en direct : identité = titre + date.
- Un post tronqué à 400 caractères cachait la pause de 90 jours du 9 avril 2025 : jugé baissier
  alors que le BTC a pris +4,3 % en une heure.
- Le chiffre d'un replay change d'une heure à l'autre : la fenêtre de 3 ans se termine
  « maintenant ». Seules les courbes d'un même replay sont comparables entre elles.
