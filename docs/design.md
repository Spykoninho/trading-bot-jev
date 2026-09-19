# Journal des choix

But du projet : comprendre comment fonctionne Jev (TypeSafe) et mesurer s'il est utile dans un
bot de trading, par rapport à un algorithme seul. Chaque entrée dit ce qui a été essayé, ce que
les données ont montré, et ce qui a été gardé.

## 1. Environnement

- Données réelles : API publique Bitvavo (bougies REST, flux WebSocket `ticker24h`), sans clé.
- Simulation : portefeuille papier local de 1 000 USDC, frais de 0,05 %, glissement de 4 points de
  base, réinitialisable. Deux modes seulement : papier par défaut, `--real` qui envoie de vrais
  ordres. Pas de testnet (§ 7).
- Alpaca (actions) écarté : inscription requise, marché fermé la nuit et le week-end.
- Devise de cotation, actifs et profondeur d'historique sortis du code (`QUOTE`, `BASES`,
  `BACKTEST_YEARS`) : `USDC` par défaut, plus rien n'est codé en dur ailleurs.

**Plateforme : Binance écarté → Bitvavo.** Binance n'a pas d'agrément MiCA et les paires en USDT ne
sont plus proposées aux résidents de l'EEE par les plateformes agréées. Bitvavo est retenu parce
qu'il est agréé MiCA, cote des paires accessibles depuis la France, et publie un historique public
de bougies 4 h remontant à 2020 en euros (juillet 2024 en USDC). Kraken a été
écarté : son API publique ne renvoie que les 720 dernières bougies, beaucoup trop peu. Les bougies
sont lues **sur la plateforme d'exécution et dans la devise de cotation employée** : le signal de
tendance et l'exécution partagent la même unité, sans dérive de change injectée dans le signal.

**Devise de cotation : EUR → USDC** (19/09/2026). Deux raisons distinctes. (1) *Frais* : au barème
officiel, les paires crypto en EUR sont en catégorie A (0,15 % maker / 0,25 % taker), les paires
crypto en USDC en **catégorie B, 0,05 % maker comme taker** ; BTC-USDC, ETH-USDC et SOL-USDC le
confirment via le champ `feeCategory` de l'API. Les paires de stablecoins (USDC-EUR) sont en
catégorie C, 0,10 %. (2) *Déclaratif* : en revenant en USDC plutôt qu'en euros, le bot n'effectue
pas de cession contre monnaie ayant cours légal — traitement prudent et non acquis, détaillé dans
le README. Comparaison sur la même période exactement, `QUOTE=EUR FEE=0.0025 SLIPPAGE_BPS=2
BACKTEST_YEARS=2.155 npm run backtest` contre le défaut : biais + veto **+58,1 %** en EUR
(Sharpe 0,92, creux 28,0 %, 91 allers-retours, ≈ 169 € de frais) contre **+82,1 %** en USDC
(Sharpe 1,35, creux 26,0 %, 85 allers-retours, 33 USDC de frais), sans news +59,3 % contre +84,9 %,
acheter-et-garder −5,3 % contre −2,5 %. Soit ~24 points, dont ~3 dus au seul change et l'essentiel
aux frais. Contreparties assumées : le cash du bot (~47 % du temps) est en dollars, donc soumis à
l'EUR/USD ; risque d'émetteur et de décrochage de l'USDC (mars 2023) invisible dans une equity
libellée en USDC ; carnet ~40× moins profond qu'en EUR (≈ 1,8 M contre ≈ 69 M de volume 24 h sur
BTC), écart achat/vente de 3 à 5 pb contre 0,1, d'où `SLIPPAGE_BPS=4` ; historique limité à
juillet 2024, donc ~2 ans de backtest ; conversion euros ↔ USDC à faire à la main, aux deux bouts.

## 2. Stratégie de prix

| Essai | Résultat sur données réelles, frais inclus | Décision |
| --- | --- | --- |
| Micro-trading, EMA 10 s / 60 s | ≈ +0,5 % brut sur 3 h, presque aucun aller-retour gagnant après frais | Abandonné |
| Retour à la moyenne (RSI), tendance en 1 h | Mangés par les frais et les faux signaux | Abandonné |
| Long/short, vote de plusieurs signaux | Pas mieux, plus de rotation | Abandonné |
| **EMA 200 en 4 h, bande d'hystérésis de 1 %** | +144,8 % sur 2,82 ans (BTC + ETH + SOL en EUR, frais 0,25 %), creux 28,5 %, Sharpe 1,11, contre +68,3 % / 66,9 % / 0,61 en acheter-et-garder | **Retenu** |

La stratégie divise le pire creux par ~2,4 et double le Sharpe sans rendre beaucoup plus : c'est un
outil de réduction du risque. Sur les anciennes données (USDT, 0,1 %), le BTC seul donnait +108,9 %
contre +107,3 % en acheter-et-garder, avec un creux de 29 % contre 53 % — même conclusion.

**Robustesse des paramètres**, mesurée sur les données USDT à 0,1 % (écarts relatifs, pas niveaux),
à départ commun : sur la grille EMA 100–300 × bande 0–3 %, le Sharpe va de 0,49 à 1,01 ; sur le
voisinage proche (EMA 150–250, bande 0,5–2 %), de 0,77 à 1,01. Pas de falaise, mais le réglage
retenu est **au sommet de la grille** : borne haute, pas garantie. L'ancienne formule « les
réglages voisins donnent des résultats proches » était trompeuse.

SOL ajouté comme actif plus volatil (≈ 1,8 × le BTC), AVAX écarté (−5 %) — mais ce tri a été fait
**sur la période même qui sert ensuite de mesure** : c'est un biais de sélection assumé, et
l'univers est composé de gagnants connus, sur une fenêtre qui commence après FTX.

Le direct et le backtest partagent la même fonction `decide`, sur bougies clôturées uniquement :
décision à la clôture, exécution à l'ouverture suivante, avec le même dimensionnement (part égale
de l'equity courante, réserve événementielle de 10 % en plancher de cash).

## 3. Testé et écarté

Toutes les mesures de cette section datent des données **USDT à 0,1 % de frais** : elles donnent
des écarts relatifs entre variantes, pas des niveaux comparables aux chiffres du § 5.

| Essai | Mesure (sans news, mêmes données) | Décision |
| --- | --- | --- |
| Pondération par volatilité inverse | +158,7 % / Sharpe 1,16 contre +197,7 % / 1,22 pour les parts égales | Écarté |
| Rotation vers le meilleur momentum 30 j | top-1 +10,9 % contre +124,2 % pour les parts égales, à départ commun | Écarté |
| Stop-loss −5 % et −12 %, stop suiveur −10 % et −15 % | Dégradent **et** le rendement **et** le creux, dans les quatre cas | Écarté |
| Trading on-chain via DEX | Glissement 30–100 pb par échange, plus gas et MEV, contre 3 à 5 pb sur le carnet USDC de Bitvavo | Écarté |

La mesure des pondérations date d'avant l'ajout du glissement et de la réserve : seul l'écart
relatif est exploitable, pas le niveau. Les stops sont inutiles ici parce que **la sortie sous
l'EMA est déjà le stop** : la pire perte sur une opération est de l'ordre de −7 %, aucun stop plus
serré n'a donc de matière à couper, et les plus larges ne font que sortir aux mauvais moments.

**Structure du portefeuille**, sur la période (mêmes données USDT) : corrélations 4 h BTC/ETH 0,81,
BTC/SOL 0,74, ETH/SOL 0,73 — trois actifs corrélés à ~0,8 ne sont pas une diversification. Les
trois lignes sont ouvertes ensemble 34 % du temps, aucune ligne 37 % du temps, et le cash
représente 47 % de l'equity en moyenne. La taille est une part égale de l'equity courante **à
l'achat**, sans rééquilibrage ensuite : une ligne a atteint 44,8 % du portefeuille. Un plafond de
poids (~40 %) est une piste, pas une fonctionnalité.

## 4. Rôle de Jev

- Questions génériques par publication : `asset` (Choice), `sentiment` (Score), `material` et
  `regulatory_risk` (Noul). Le code en tire un biais news par actif (pondéré par matérialité,
  confiance et fraîcheur, demi-vie de 3 h) qui décale les seuils d'au plus ±0,5 %, et un veto
  réglementaire sur les achats.
- Questions propres à chaque source primaire (`SOURCE_RULES`), posées dans la même requête, et
  composées en code : décision de taux de la Fed ; escalade, détente, soutien crypto et escalade
  militaire pour Trump (signaux opposés = neutre) ; portée pour la SEC ; type d'annonce Binance.
- Texte complet quand il existe : post entier, page du communiqué de la Fed, résumé RSS de la SEC.
  Le texte des sources est marqué comme donnée citée non fiable, dans le state et dans chaque
  question.
- Chaque jugement porte des `signals` **numériques** séparés des `details` d'affichage. Avant cette
  séparation, une règle ne pouvait lire que le libellé affiché — `Number("cut (0.93)")` valait
  `NaN` — et seule la règle sur Trump pouvait se déclencher ; les règles Fed, SEC et listings
  Binance sont désormais écrivables.

**Les sources sondées.** Une requête par publication, toutes les questions évaluées en parallèle
(`brain.ts`) ; le *state* envoyé est un objet nommé (`untrusted_headline`, `untrusted_text`,
`source`, `published_at`). Chaque publication n'est jugée qu'une fois : changer les poids ne
rappelle pas le modèle.

| Source | Type | Ce que lit Jev |
| --- | --- | --- |
| CoinDesk, Cointelegraph | presse, 60 s | le titre |
| Trump (Truth Social, via trumpstruth.org) | primaire, 30 s | le post entier |
| Fed | primaire, 30 s | le texte de la page du communiqué |
| SEC | primaire, 60 s | le résumé du flux (le site refuse les robots) |
| Binance (annonces) | primaire, 30 s | le titre |

Les annonces de listing et de retrait de cotation de Binance restent une **source d'actualité**
utile quelle que soit la plateforme d'exécution : elles bougent les prix partout.

**Seuils restés arbitraires**, honnêtement non calibrés : `SURE` = 0,6 (certitude minimale d'une
réponse de source avant composition), `news.minConfidence` = 0,5 (choix d'actif retenu),
`news.halfLifeHours` = 3 (fraîcheur), `news.regulatoryRisk` = 0,7 (veto), `isStrong`
(`material` ≥ 0,7 et `|sentiment|` ≥ 0,5, qui définit le « fort impact » de l'étude). Ils ont été
posés à vue et n'ont pas été balayés ; une calibration de `material` par déciles est une piste.
`newsTilt` est laissé à 0,5 % : un réglage à 2 % donnerait plus, mais ce serait s'ajuster sur la
période même qu'on mesure. Seuls les coefficients d'`EFFECT` sont calibrés, par l'étude
d'événements — d'où les zéros sur les escalades commerciales et militaires.

## 5. Mesures

**Avec ou sans Jev** (`npm run history`, puis `npm run backtest`). Mesure de référence, seule à
couvrir ~3 ans et conservée telle quelle : BTC-EUR + ETH-EUR + SOL-EUR sur bougies Bitvavo 4 h, du
25/11/2023 au 18/09/2026 (≈ 2,82 ans), frais 0,25 % (taker, ancien barème), glissement 2 pb,
capital 1 000 €, 49 496 publications d'époque, fenêtre de news 24 h, titres visibles 2 min après
parution.

| Variante | Rendement | Pire creux | CAGR | Sharpe | Sortino | MAR | Allers-retours | Gagnants | Frais EUR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sans news | +144,8 % | 28,5 % | 37,4 % | 1,11 | 1,61 | 1,31 | 125 | 35 | 336 |
| Biais seul | +142,3 % | 28,0 % | 36,9 % | 1,10 | 1,59 | 1,32 | 132 | 34 | 350 |
| Veto seul | +145,3 % | 28,5 % | 37,5 % | 1,11 | 1,61 | 1,32 | 125 | 35 | 337 |
| Biais + veto | +142,7 % | 28,0 % | 37,0 % | 1,10 | 1,59 | 1,32 | 132 | 34 | 351 |
| Acheter et garder | +68,3 % | 66,9 % | 20,3 % | 0,61 | 0,85 | 0,30 | 1 | — | 2,50 |

Apport de Jev : **−2,1 points sur 2,8 ans**, c'est-à-dire rien de mesurable, et du mauvais côté. Le
biais ajoute 7 allers-retours donc des frais ; le veto ne change presque rien. Sont périmés les
+204,5 % contre +194,8 % d'avant la réserve de 10 %, le glissement et la latence de lecture. Le
backtest ne rejoue que la tendance : le circuit événementiel n'y est pas.

**Configuration par défaut** (BTC-USDC + ETH-USDC + SOL-USDC, 29/09/2024 → 19/09/2026 ≈ 1,97 an,
frais 0,05 %, glissement 4 pb) : sans news +84,9 % (creux 26,2 %, Sharpe 1,39, 78 allers-retours,
31 USDC de frais) ; biais seul +81,9 % (1,35) ; veto seul +85,1 % (1,39) ; biais + veto +82,1 %
(creux 26,0 %, Sharpe 1,35, Sortino 2,07, MAR 1,37, 85 allers-retours, 20 gagnants, 33 USDC) ;
acheter et garder −2,5 % (creux 63,3 %, Sharpe 0,19). Apport de Jev : **−2,8 points**. Troisième
mesure du même écart, troisième valeur — +4,9 (USDT 0,1 %), −2,1 (EUR 0,25 %), −2,8 ici : **le
signe change avec la devise et les frais**, c'est du bruit. Deux ans, une seule période, plate pour
acheter-et-garder, et un Sharpe de 1,35 sur 2 ans ne se compare pas à 1,10 sur 2,8 ans.

**Sensibilité aux frais** (`npm run backtest -- --fees`, ligne biais + veto, série EUR de
référence) : 0,05 % → +183,7 % (Sharpe 1,27, creux 24,9 %, CAGR 44,8 %, 76 € de frais payés) ;
0,15 % → +162,4 % (1,19) ; 0,25 % → +142,7 % (1,10, 349 €) ; 0,40 % → +116,0 % (0,98), contre
≈ +68 % en acheter-et-garder. C'est ce qui a motivé le passage aux paires USDC (§ 1) et ce qui rend
la piste « ordres limite » sans objet : en catégorie B, maker et taker coûtent la même chose.

**Profil des allers-retours** : 132 opérations en EUR (264 ordres), 25,8 % gagnantes, médiane
−2,72 %, p10 −4,61 %, p90 +11,00 %, pire perte −6,93 %, les 5 meilleures faisant 136 % du gain
cumulé ; 85 opérations en USDC, 23,5 % gagnantes, médiane −2,41 %, p10 −5,18 %, p90 +10,27 %, pire
perte **−11,94 %**, les 5 meilleures faisant 206 % du gain cumulé. Soit 14 à 16 allers-retours par
an et par actif. La pire perte plus lourde en USDC vient probablement de mèches sur un carnet peu
profond au lancement de ces marchés — hypothèse non vérifiée.

**Provenance des publications d'époque** : captures RSS de la Wayback Machine (CoinDesk,
Cointelegraph, SEC), index horodaté de la Fed, archive publique des posts de Trump, API d'annonces
Binance paginée. Écartés : API d'actualités à clé, GDELT (bloque cette adresse IP), sitemap
Cointelegraph (dates faussées par une migration du site). L'archive Trump est le maillon fragile :
un fichier JSON hébergé par un média, non officiel, sans garantie de disponibilité ni
d'exhaustivité — et le flux temps réel passe lui aussi par un agrégateur tiers (`trumpstruth.org`).
Si l'un des deux disparaît, la source Trump disparaît avec lui.

**Étude d'événements** (`npm run study`), entrée 2 min après la publication, dans le sens de Jev,
avec un groupe témoin de titres anodins à sens alterné. Mesurée sur le cache historique de bougies
minute **en USDT** (recherche passée) avec des frais de 0,1 % × 2 : les colonnes « net » sont donc
à lire à ce tarif. En paires USDC l'aller-retour revient à ≈ 0,18 % (0,05 % × 2 plus ~4 pb de
glissement par ordre), soit ~0,02 point de moins partout ; en paires EUR, à 0,5 %, soit 0,3 de plus.
Le dernier horizon est +238 min et non +4 h rondes : le cache s'arrête à t0 + 240 min et l'entrée
se fait à +2.

| Groupe | n | Avant (−60→0) | +1 h | Net de frais | Écart au témoin à 1 h |
| --- | --- | --- | --- | --- | --- |
| Presse, fort impact | 1 201 | +0,057 % (p = 0,013) | +0,032 % (p = 0,075) | −0,168 % | +0,051 pt (p = 0,040) |
| Sources primaires, fort impact | 253 | — | — | −0,201 % | — |
| Fed, baisses ou hausses | 7 | +0,43 % | −0,48 % (p = 0,071) | — | — |
| Trump, escalade commerciale | 99 | — | — | — | indiscernable |
| Trump, escalade militaire | 66 | — | — | — | indiscernable |
| Trump, soutien crypto | 13 | — | +0,63 % (p = 0,034) | +0,43 % (p = 0,15) | +0,65 pt (p = 0,029) |
| Témoin | 1 545 | — | — | −0,219 % | — |

Lecture : Jev repère surtout des titres qui **suivent** un mouvement. Le cas Fed sépare deux
résultats distincts : les 25 décisions de taux sont **classées** sans erreur (résultat de lecture),
mais l'effet **prix** ne porte que sur 7 cas, trop peu pour conclure sur le signe. Le soutien
crypto de Trump est une hypothèse, pas un résultat : net de frais son p remonte à 0,15, une
dizaine de sous-groupes ont été testés sans correction pour tests multiples, et les 13 posts se
concentrent sur ~4 épisodes d'un marché haussier. En paires EUR, son +0,63 % brut à 1 h tombait à
≈ +0,13 % ; en paires USDC il en reste ≈ +0,45 %, ce qui rend l'hypothèse testable sans la
valider — le carnet USDC est en outre moins profond que celui de la mesure. Brut à +238 min :
+1,12 %.

**Test en direct** (`events.ts`) : publications vues moins de 5 min après leur parution, prix à la
détection puis à +5 min, +15 min, +1 h, +4 h, sans rien recalculer après coup. Seule mesure à
l'abri de la mémoire du modèle, dont la version actuelle est sortie le 10 septembre 2026.
6 événements suivis à ce jour. Le **replay** de l'interface, lui, anime les mêmes courbes avec la
fonction de décision du direct.

**L'expérience à deux comptes.** Pour savoir ce que le bot apporte en réel, il faut un témoin :
même capital, même jour, compte A confié au bot et compte B avec un tiers sur chaque actif puis
plus rien, relevés à dates fixes, frais compris. Moins de 6 à 12 mois ne dit rien, et il faut avoir
traversé une vraie baisse, là où le backtest place tout l'avantage du bot. L'expérience mesure
« bot contre rien faire », pas « Jev contre algorithme seul » — cet apport-là se lit dans le
backtest, et il est nul.

## 6. Circuit immédiat

Une bougie de 4 h est trop lente pour une news. `EVENT_RULES` déclenche un achat dès la détection,
dans un livre de positions séparé (`event:<symbole>`), sur une réserve de 10 % de l'equity, avec
sortie programmée. Une seule règle, celle que l'étude soutient le moins mal : soutien crypto de
Trump ≥ 0,8, revente après 4 h. Comme elle ne repose que sur n = 13, elle est **active en papier,
désactivée avec `--real`** sauf `--events` explicite. Une règle qui viserait un signal que sa
source n'émet pas fait échouer le démarrage plutôt que de ne jamais se déclencher.

## 7. Exécution sur Bitvavo

**Pas de testnet.** Bitvavo n'offre pas de bac à sable, et répéter les ordres sur celui d'une autre
plateforme ne testerait pas cet adaptateur-ci : le mode `--live` a donc été supprimé et la commande
renvoie une erreur qui explique quoi faire à la place (papier, puis `--real` avec un `START_CASH`
minuscule, en USDC — l'ordre minimum est de 5 USDC côté Bitvavo, 10 côté portefeuille papier).

Le portefeuille papier reste la source de vérité de l'interface ; `--real` réplique chaque ordre en
ordre au marché. Le bot retient la quantité réellement reçue à l'achat (`filledAmount` moins les
frais quand ils sont prélevés dans l'actif, `netBaseQty`) et ne revend que celle-là, arrondie vers
le bas au pas de cotation : il ne touche jamais au reste du compte. Garde-fous : `--real` exige les
clés `BITVAVO_API_KEY` / `_SECRET`, un `BITVAVO_OPERATOR_ID` entier (Bitvavo l'impose sur chaque
ordre) et un `START_CASH` explicite ; réconciliation du solde au démarrage puis toutes les heures,
avec bandeau de désynchronisation dans l'interface ; aucun ordre sur un prix vieux de plus de 30 s ;
marché refusé si son statut n'est pas `trading` ; quantité et montant minimaux, synchronisation
d'horloge sur `/time` (fenêtre signée de 10 s), limites de débit, détection des ventes partielles ;
un actif dont les bougies ne se chargent plus est mis de côté sans bloquer les autres ; une
nouvelle simulation est refusée tant que des positions sont ouvertes sur l'exchange.

**Ce que le bot ne peut plus vérifier** : Bitvavo n'expose pas les droits d'une clé API. Le
contrôle automatique « cette clé autorise les retraits, je refuse de démarrer », possible
auparavant, a disparu ; la consigne « clé sans droit de retrait, IP en liste blanche » est
désormais purement documentaire.

Détails d'API : signature HMAC-SHA256 en hexadécimal de `timestamp + méthode + chemin + corps` ;
`clientOrderId` UUID **déterministe** dérivé du libellé de l'ordre papier, pour qu'un même ordre
rejoué ne soit pas dupliqué ; un 429 attend la réinitialisation du quota (`bitvavo-ratelimit-resetat`)
et n'est **jamais** rejoué sur un ordre, seulement sur une lecture ; les erreurs sont nettoyées de
toute clé avant journalisation.

**Bougies et prix** : l'API plafonne à 1 440 bougies par réponse et **ignore un `start` envoyé
seul**, donc l'historique se pagine à rebours avec `end`, page par page, jusqu'à la profondeur
voulue. En minute, une minute sans transaction n'existe pas : `fetchCandleAt` prend donc la
dernière bougie ≤ à l'horodatage visé. Le prix temps réel vient du canal WebSocket `ticker24h`,
poussé une fois par seconde, avec reconnexion à délai doublé et jitter.

Chaque clôture de bougie consigne la décision de chaque actif, « attendre » compris, et tout ordre
refusé avec sa raison (`state.waits`). Toute anomalie passe par `alert()` : journal `alerts` des
100 dernières entrées, un même message au plus une fois par tranche de 10 min, lu par l'interface
(toasts, cloche, bandeau).

Déclenchent une alerte (`src/bot.ts`) : tout échec d'ordre réel et toute vente partielle ; tout
écart à la réconciliation horaire ; un actif dont les bougies ne se chargent plus ; une source
d'actualités injoignable ; un échec de jugement par Jev ; un ordre reporté faute de prix frais ou
refusé faute de cash ; la coupure et le retour du flux de prix ; l'archivage d'une simulation
incompatible ; toute erreur interne.

Côté interface : **toasts**, quatre au maximum, une erreur restant jusqu'à fermeture manuelle, un
avertissement ou une info disparaissant après 8 s (décompte en pause au survol ou au focus
clavier) ; **cloche** avec compteur de non-lus et panneau d'historique, position de lecture gardée
dans le navigateur — un rechargement ne rejoue donc pas l'historique en toasts, seules les erreurs
de moins de 10 minutes sont remontrées ; **toast « Connexion au bot perdue »** persistant quand le
flux SSE tombe, remplacé par une info au rétablissement ; **bandeau rouge persistant** pour ce qui
demande une intervention (désynchronisation avec le compte, actif dont les cours ne se chargent
plus). Le bot ne répare pas une désynchronisation tout seul.

## 8. Pièges rencontrés

- Identifier une publication par son seul titre fusionnait les huit « Federal Reserve issues FOMC
  statement » annuels et aurait fait ignorer le suivant en direct : identité = titre + date.
- Un post tronqué à 400 caractères cachait la pause de 90 jours du 9 avril 2025 : jugé baissier
  alors que le BTC a pris +4,3 % en une heure.
- Une publication que l'API n'a pas su juger était marquée comme vue et perdue pour toujours ;
  elle est désormais reprise au passage suivant.
- L'archive de jugements est migrée **gratuitement** au chargement (les anciens formats sont relus,
  pas renvoyés au modèle). Mais la version des questions a été incrémentée : un `npm run history`
  complet ferait rejuger toute l'archive, soit ≈ 2,50 $.
- `data/state.json` porte l'historique d'équité à raison d'un point par minute sur 60 jours : il
  atteint environ 5 Mo à pleine fenêtre, réécrit toutes les 15 s.
- Le chiffre d'un replay change d'une heure à l'autre : la fenêtre (`BACKTEST_YEARS`, 3 ans par
  défaut, ~2 disponibles en USDC) se termine « maintenant ». Seules les courbes d'un même replay
  sont comparables entre elles.
- Un état enregistré dans une autre devise (portefeuille en EUR ou en USDT) ne peut pas être
  repris : il est archivé en `data/state.<horodatage>.bak.json` et le bot repart d'un portefeuille
  neuf. La devise est écrite dans le fichier (`quote`) pour détecter le cas.
- **Dette de nommage connue** : le champ `Trade.usdt` désigne un montant dans la devise de
  cotation, donc des USDC. Il est lu par le portefeuille, le backtest et le miroir d'exécution ;
  le renommer est mécanique mais touche l'état persisté.
- Le cache de l'étude d'événements (`data/event-klines.json`) est libellé en marchés Binance USDT.
  Ses clés sont conservées pour continuer à lire l'existant hors ligne ; les nouveaux relevés
  arrivent de Bitvavo sous une clé distincte, pour ne jamais mélanger les devises.
