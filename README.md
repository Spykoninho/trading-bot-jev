# trading-bot-jev

## 1. Le projet

Un bot de trading crypto construit pour répondre à une question : **à quoi sert Jev**, le modèle
« System One » de [TypeSafe](https://typesafe.ai), et **apporte-t-il quelque chose par rapport à
un algorithme seul ?**

Le bot suit les prix Binance en temps réel, fait lire l'actualité à Jev, décide avec un
algorithme, et exécute sur un portefeuille papier de 1 000 USDT (ou, sur demande explicite, sur
un vrai compte). Une interface web montre tout en direct. Par défaut aucune vraie monnaie n'est
en jeu, et rien ici n'est un conseil d'investissement.

```bash
npm install
cp .env.example .env   # puis remplir TYPESAFE_API_KEY (console.typesafe.ai)
npm start              # bot + interface sur http://localhost:3210
```

## 2. Comment il fonctionne

### Jev lit, l'algorithme décide

| | Jev (TypeSafe) | L'algorithme (code) |
| --- | --- | --- |
| Entrée | Du texte : titre de presse, post de Trump, communiqué de la Fed ou de la SEC | Des nombres : prix Binance, moyenne mobile, cash, frais |
| Travail | Répond à des questions fermées sur ce texte, en ~100 ms, avec une probabilité | Calcule la tendance, fixe les seuils, dimensionne et exécute les ordres |
| Sortie | Un jugement typé : « parle du BTC (0,97) », « décide une hausse de taux (1,00) », « soutient la crypto (0,93) » | Acheter, vendre ou attendre |
| Ce qu'il ne fait pas | Ne prédit pas un prix, ne décide jamais d'un ordre, ne génère pas de texte | Ne sait pas lire : sans Jev, un post ou un communiqué est une chaîne de caractères opaque |

### L'algorithme

**Suivi de tendance** sur bougies de 4 h, choisi par backtest (le micro-trading et le retour à la
moyenne perdent après frais) :

```
une bougie clôture au-dessus de EMA 200 × 1,01  → acheter
une bougie clôture sous      EMA 200 × 0,99  → tout vendre
entre les deux                                 → attendre
```

Le capital est réparti à parts égales entre les actifs choisis au lancement (BTC, ETH, SOL), hors
une réserve de 10 %. À chaque clôture de bougie, la décision de chaque actif est consignée dans
l'interface, y compris « attendre ». Les réglages voisins (EMA 150 à 300, bande 0 à 2 %) donnent
des résultats proches : ce n'est pas un réglage chanceux.

**Circuit immédiat** : une bougie de 4 h est trop lente pour une news. Une règle explicite
(`eventRules` dans `config.ts`) agit dès la détection : aujourd'hui, un post de Trump jugé
« soutien à la crypto » à plus de 0,8 déclenche l'achat de 10 % du capital, revendu 4 h plus tard,
dans un livre de positions séparé de la tendance.

### Jev

Une requête par publication. Le *state* envoyé est un objet nommé (`headline`, `full_text`,
`source`, `published_at`) ; toutes les questions sont évaluées en parallèle (`brain.ts`).

| Notion TypeSafe | Exemple dans ce projet |
| --- | --- |
| **Choice** : une option parmi un ensemble fermé, avec probabilités et confiance | `asset` : BTC, ETH, SOL, marché crypto, sans rapport ; `rate_decision` de la Fed |
| **Score** : position sur des niveaux ordonnés décrits par des situations concrètes | `sentiment`, de « hack, interdiction » à « ETF approuvé, baisse de taux surprise » |
| **Noul** : probabilité qu'une condition soit vraie | `material`, `regulatory_risk`, `crypto_support`, `trade_escalation`… |
| **Fan-out spéculatif** : poser d'emblée des questions qui ne serviront que dans certains cas | Questions propres à la Fed, à Trump, à la SEC, à Binance, dans la même requête |
| **Le code compose** | Signaux opposés d'un même post = neutre ; petite affaire SEC = impact plafonné |
| **Confidence gating** | Un actif peu sûr (`confidence < 0,5`) ou « sans rapport » est ignoré |
| **Fraîcheur** | Un jugement perd la moitié de son poids toutes les 3 h |
| **Règle séparée du score** | Un risque réglementaire récent et fort bloque tout achat |
| **Jugements réutilisables** | Chaque publication n'est jugée qu'une fois ; changer les poids ne rappelle pas le modèle |

Dans la stratégie de tendance, le biais news tiré de ces jugements décale les deux seuils d'au
plus ±0,5 %.

### Les sources

| Source | Type | Ce que lit Jev |
| --- | --- | --- |
| CoinDesk, Cointelegraph | presse, 60 s | le titre |
| Trump (Truth Social, via trumpstruth.org) | primaire, 30 s | le post entier |
| Fed | primaire, 30 s | le texte de la page du communiqué |
| SEC | primaire, 60 s | le résumé du flux (le site refuse les robots) |
| Binance (annonces) | primaire, 30 s | le titre |

Une publication est identifiée par son titre **et** sa date : la Fed réutilise « Federal Reserve
issues FOMC statement » huit fois par an.

### Les mesures intégrées

| Commande | Rôle |
| --- | --- |
| `npm run history` | Reconstitue les publications des 3 dernières années (Wayback Machine, index de la Fed, archive des posts de Trump, API Binance) et les fait juger par Jev (≈ 2,50 $ de crédits) |
| `npm run backtest` | Compare en console : algorithme + Jev, algorithme seul, acheter et garder |
| `npm run study` | Étude d'événements : le prix bouge-t-il avant ou après une publication ? |
| Replay (interface) | Les mêmes trois courbes, animées, avec la même fonction de décision que le direct |
| Test en direct (interface) | Toute publication captée moins de 5 min après sa parution est enregistrée avec le prix du moment, puis le prix est relevé à +5 min, +15 min, +1 h, +4 h. Rien n'est recalculé après coup. |

### Architecture

```
market.ts       bougies REST (+ historique paginé) et flux WebSocket de prix Binance, sans clé
news.ts         sources sondées : presse et primaires, texte complet quand il existe
brain.ts        questions TypeSafe, règles par source, appel à Jev
strategy.ts     biais news, tendance EMA avec hystérésis, décision
portfolio.ts    portefeuille papier : ordres au prix réel, frais, livre « tendance » et livre « événement »
events.ts       test en direct, règles du circuit immédiat, bilan
backtest.ts     rejoue `decide` bougie par bougie, avec ou sans les jugements d'époque
history.ts      archives des publications d'époque
event-study.ts  étude d'événements sur l'historique
broker.ts       exécution sur Binance (testnet ou réel) : ordres signés, quantités exactes
bot.ts          boucles temps réel et état ; server.ts : API locale + flux SSE ; public/ : interface sans build
```

L'état est persisté dans `data/` (non versionné). Le journal des choix est dans `docs/design.md`.
`npm test` et `npm run typecheck` vérifient le code.

## 3. Compte rendu des observations

### Jev et l'algorithme, en deux phrases

> **Jev lit, l'algorithme décide.** Jev est un petit modèle d'IA qui ne génère pas de texte : on
> lui donne un texte et des questions fermées (« de quel actif ça parle ? », « est-ce une hausse
> de taux ? »), il répond en un dixième de seconde avec une probabilité, dans un format que le
> code utilise directement. L'algorithme fait tout le reste : il suit les prix, calcule la
> tendance, décide d'acheter ou de vendre et passe les ordres ; sans Jev il ne sait pas lire, avec
> Jev il reçoit quelques chiffres fiables qu'il combine avec ses propres règles.

### Jev est-il utile, par rapport à un algorithme seul ?

Sur 3 ans de bougies Binance réelles (BTC + ETH + SOL), frais de 0,1 % par ordre inclus, avec
49 496 publications d'époque rejouées sans regard vers le futur :

| Variante | Rendement | Pire creux |
| --- | --- | --- |
| Algorithme **+ Jev** (texte complet, questions par source) | **+204,5 %** | −30,4 % |
| Algorithme seul | +194,8 % | −31,3 % |
| Acheter et garder | +68,9 % | −64,6 % |

1. **Pour gagner de l'argent, c'est l'algorithme qui fait le travail.** La règle de tendance
   explique presque tout l'écart avec « acheter et garder ». En marché baissier elle ne gagne pas,
   elle évite surtout de perdre (−4 % la dernière année contre −40 %).
2. **Jev ajoute un plus modeste, qui grandit quand il lit mieux** : +3 points avec des titres de
   presse, +4,5 avec les sources primaires en titres seuls, +9,7 avec le texte complet et des
   questions propres à chaque source. Sur ~130 ordres, cela reste compatible avec du hasard. La
   façon de poser les questions compte autant que le modèle.
3. **Réagir à la presse ne marche pas** : le prix a déjà bougé dans l'heure qui précède l'article
   (+0,057 %, net statistiquement) et il ne reste rien après. « Suivre Jev une heure » coûte
   −0,17 % par ordre, frais inclus. Jev lit juste, mais l'information est vieille.
4. **Lire vite et tout lire ne suffit pas non plus : il faut une surprise.** Jev a identifié sans
   erreur les 25 décisions de taux de la Fed, mais après 5 des 6 baisses le BTC a *baissé* : elles
   étaient attendues. Les escalades commerciales (97 posts) et militaires (66) de Trump n'ont eu
   aucun effet mesurable. Un seul signal ressort : ses posts de **soutien à la crypto** (+0,63 % à
   1 h, +1,10 % à 4 h), sur 13 cas seulement et après une dizaine de sous-groupes testés.

**Conclusion.** Jev est un outil de lecture, pas de prédiction. Dans ce cas d'usage il n'est pas
un moteur de performance : il ne remplace pas une bonne règle de prix et n'ajoute que quelques
points. Sa valeur est ailleurs et elle est réelle : il rend *programmable* ce qu'un algorithme ne
peut pas traiter. Classer 25 communiqués de la Fed sans erreur, voir qu'un post annonce à la fois
une hausse et une pause de droits de douane, écarter 17 000 posts sans rapport, pour environ
2,50 $ et ~100 ms par texte, là où un LLM classique serait plus lent, plus cher, et rendrait du
texte libre à retraiter. Il vaut donc pour les tâches où le texte est le signal (tri, routage,
extraction, vérification) ; en trading, il ne vaut que si l'on dispose d'une information que le
marché n'a pas déjà. Le test en direct dira si c'est le cas pour les posts de Trump.

Limites de ces mesures : 3 ans d'historique seulement (un cycle de hausse puis de baisse), actifs
très corrélés, achat uniquement, pas de glissement simulé, et un modèle entraîné après coup peut
connaître la suite de certains événements, d'où le test en direct. Le chiffre d'un replay change
d'une heure à l'autre, car la fenêtre de 3 ans se termine « maintenant » : seules les courbes d'un
même replay sont comparables.

## 4. L'utiliser en conditions réelles

> Trader avec de l'argent réel peut faire perdre tout ou partie du capital engagé. Un backtest
> décrit le passé. Ce qui suit explique comment faire fonctionner le logiciel, pas s'il faut le
> faire : n'engage que ce que tu peux te permettre de perdre.

### Les trois modes

| Commande | Ce qui se passe |
| --- | --- |
| `npm start` | Portefeuille papier uniquement. |
| `npm start -- --live` | Chaque ordre papier est aussi passé sur le **testnet** Binance (faux argent, clés `BINANCE_TESTNET_KEY` / `BINANCE_TESTNET_SECRET`). À faire tourner quelques jours avant le réel. |
| `npm start -- --real` | Chaque ordre papier est aussi passé sur **Binance réel** (clés `BINANCE_KEY` / `BINANCE_SECRET`). |

Dans les deux derniers modes, le portefeuille papier reste le tableau de bord, et le bot retient
la quantité réellement achetée (frais Binance déduits) pour revendre **exactement celle-là**,
arrondie au pas de cotation : il ne touche jamais au reste du compte. Si un ordre échoue, il est
signalé dans la console et le papier continue ; compare régulièrement avec l'application Binance.

### Mise en place

1. **Un compte dédié.** Crée un sous-compte Binance (ou un compte séparé) pour le bot, et vires-y
   le capital en USDT. Compte au moins 150 USDT : en dessous, certains ordres passent sous les
   minimums (10 USDT par ordre).
2. **Une clé API restreinte** sur ce compte : « Enable Spot Trading » seulement, **retraits
   désactivés**, liste blanche d'adresses IP. La clé reste dans `.env`, jamais ailleurs.
3. **Déclare le capital** : `START_CASH=<montant en USDT>` dans `.env`. Le bot n'engagera jamais
   plus que ce montant ; `--real` refuse de démarrer sans lui.
4. **Lance** `npm start -- --real`, puis « Nouvelle simulation » dans l'interface et coche les
   actifs. Le bot s'aligne aussitôt sur la tendance : si elle est haussière, il achète. Tant que
   des positions sont ouvertes sur Binance, l'interface refuse de recommencer à zéro.
5. **Laisse tourner en continu** (machine toujours allumée ou petit serveur). Arrêté, le bot ne
   décide plus rien ; relancé, il reprend son état et applique la décision en retard.

### L'expérience à deux wallets

Pour savoir ce que le bot apporte, il faut un témoin.

| | Wallet A : le bot | Wallet B : le témoin |
| --- | --- | --- |
| Capital | X USDT | X USDT, le même jour à la même heure |
| Gestion | `npm start -- --real`, actifs BTC + ETH + SOL | Un tiers de X sur chaque actif, puis plus rien |
| Relevé | Valeur totale en USDT, frais compris, à dates fixes (par exemple le 1er de chaque mois) | Idem |

- **Durée** : le bot fait une douzaine d'allers-retours par an et par actif. Moins de 6 à 12 mois
  ne dit rien, et il faut avoir traversé au moins une vraie baisse : c'est là que le backtest
  place tout l'avantage du bot. Dans une hausse continue, le témoin peut très bien gagner.
- **Ce que l'expérience mesure** : « bot contre rien faire », pas « Jev contre algorithme seul ».
  L'apport propre de Jev se lit dans le replay et dans le test en direct.
- **À noter en plus** : chaque écart entre le papier et le compte réel, chaque arrêt du bot, les
  frais réellement payés. Renseigne-toi aussi sur la fiscalité applicable à tes opérations.

Le serveur web n'écoute que sur `127.0.0.1`, sans authentification : sur un serveur distant,
n'ouvre pas son port, passe par un tunnel SSH.
