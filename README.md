# trading-bot-jev

Projet pédagogique : **comprendre comment fonctionne Jev**, le modèle « System One » de
[TypeSafe](https://typesafe.ai), et **mesurer s'il est utile** dans un bot de trading crypto, par
rapport à un algorithme seul. Tout tourne sur un portefeuille papier : aucune vraie monnaie n'est
en jeu, et rien ici n'est un conseil d'investissement.

## Qui fait quoi

**Jev lit, l'algorithme décide.**

| | Jev (TypeSafe) | L'algorithme (code) |
| --- | --- | --- |
| Entrée | Du texte : titre de presse, post de Trump, communiqué de la Fed ou de la SEC | Des nombres : prix Binance, moyenne mobile, cash, frais |
| Travail | Répond à des questions fermées sur ce texte, en ~100 ms, avec une probabilité | Calcule la tendance, fixe les seuils, dimensionne et exécute les ordres |
| Sortie | Un jugement typé : « parle du BTC (0,97) », « décide une hausse de taux (1,00) », « soutient la crypto (0,93) » | Acheter, vendre ou attendre |
| Ce qu'il ne fait pas | Ne prédit pas un prix, ne décide jamais d'un ordre, ne génère pas de texte | Ne sait pas lire : sans Jev, un post ou un communiqué est une chaîne de caractères opaque |

Jev transforme une phrase en quelques nombres fiables ; le code combine ces nombres avec ses
propres règles. C'est le principe de TypeSafe : des petites unités d'intelligence utilisées comme
des fonctions, pendant que le programme garde le contrôle.

## Ce qu'on a mesuré

Sur 3 ans de bougies Binance réelles (BTC + ETH + SOL), frais de 0,1 % par ordre inclus, avec
49 496 publications d'époque rejouées sans regard vers le futur :

| Variante | Rendement | Pire creux |
| --- | --- | --- |
| Algorithme **+ Jev** (texte complet, questions par source) | **+204,5 %** | −30,4 % |
| Algorithme seul (suivi de tendance) | +194,8 % | −31,3 % |
| Acheter et garder | +68,9 % | −64,6 % |

1. **L'essentiel de la performance vient de l'algorithme**, pas de Jev : une règle de tendance
   classique fait presque tout l'écart avec « acheter et garder ».
2. **Jev apporte un plus modeste, qui grandit quand il lit mieux** : +3 points avec des titres de
   presse, +4,5 en ajoutant les sources primaires en titres seuls, +9,7 avec le texte complet et
   des questions propres à chaque source. Sur ~130 ordres, cela reste compatible avec du bruit.
3. **Réagir aux news ne marche pas avec de la presse** : le prix a déjà bougé dans l'heure qui
   précède l'article (+0,057 %, net statistiquement) et il ne reste rien après. Jev lit juste,
   mais l'information est vieille.
4. **Lire vite et tout lire ne suffit pas non plus** : il faut que l'information soit une
   surprise. Après 5 des 6 baisses de taux de la Fed, parfaitement identifiées par Jev, le BTC a
   *baissé* : elles étaient attendues. Les escalades commerciales (97 posts) et militaires (66) de
   Trump n'ont eu aucun effet mesurable. Un seul signal ressort : ses posts de **soutien à la
   crypto** (+0,63 % à 1 h, +1,10 % à 4 h), mais sur 13 cas seulement.

**Conclusion.** Dans ce cas d'usage, Jev n'est pas un moteur de performance : il ne remplace pas
une bonne règle de prix et n'ajoute que quelques points. Son utilité est ailleurs et elle est
réelle : il rend *programmable* ce qu'un algorithme ne peut pas traiter. Classer 25 communiqués
de la Fed sans erreur, repérer qu'un post annonce à la fois une hausse et une pause de droits de
douane, écarter 17 000 posts politiques sans rapport, le tout pour environ 2,50 $ et ~100 ms par
texte, là où un LLM classique serait trop lent, trop cher et à la sortie non typée. Il vaut donc
pour les tâches où le texte est le signal (tri, routage, extraction, vérification) ; en trading,
il ne vaut que si l'on dispose d'une information que le marché n'a pas déjà.

## Démarrer

```bash
npm install
cp .env.example .env   # puis remplir TYPESAFE_API_KEY (console.typesafe.ai)
npm start              # bot + interface sur http://localhost:3210
```

| Commande | Rôle |
| --- | --- |
| `npm start -- --live` | Chaque ordre papier est aussi envoyé au testnet Binance (clés optionnelles dans `.env`) |
| `npm run history` | Reconstitue les publications d'époque et les fait juger par Jev (≈ 2,50 $ de crédits) |
| `npm run backtest` | Compare en console : algorithme + Jev, algorithme seul, acheter et garder |
| `npm run study` | Étude d'événements : le prix bouge-t-il avant ou après une publication ? |
| `npm test`, `npm run typecheck` | Tests et typage |

## Ce que fait l'algorithme

**Suivi de tendance** sur bougies de 4 h, choisi par backtest (le micro-trading et le retour à la
moyenne perdent après frais) :

```
une bougie clôture au-dessus de EMA 200 × 1,01  → acheter
une bougie clôture sous      EMA 200 × 0,99  → tout vendre
entre les deux                                 → ne rien changer
```

Le capital est réparti à parts égales entre les actifs choisis au lancement de la simulation
(BTC, ETH, SOL), hors une réserve de 10 %. Les réglages voisins (EMA 150 à 300, bande 0 à 2 %)
donnent des résultats proches : ce n'est pas un réglage chanceux. Environ 12 allers-retours par
an et par actif, dont un quart de gagnants : la règle perd souvent un peu et gagne rarement
beaucoup.

**Circuit immédiat** : une bougie de 4 h est trop lente pour une news. Une règle explicite
(`eventRules` dans `config.ts`) agit dès qu'un événement est capté : aujourd'hui, un post de Trump
jugé « soutien à la crypto » à plus de 0,8 déclenche l'achat de 10 % du capital, revendu 4 h plus
tard. C'est la seule règle que l'étude soutient, et elle reste à confirmer en direct.

## Ce que fait Jev

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

Dans la stratégie de tendance, le biais news décale les deux seuils d'au plus ±0,5 %.

## Sources

| Source | Type | Ce que lit Jev |
| --- | --- | --- |
| CoinDesk, Cointelegraph | presse, 60 s | le titre |
| Trump (Truth Social, via trumpstruth.org) | primaire, 30 s | le post entier |
| Fed | primaire, 30 s | le texte de la page du communiqué |
| SEC | primaire, 60 s | le résumé du flux (le site refuse les robots) |
| Binance (annonces) | primaire, 30 s | le titre |

Une publication est identifiée par son titre **et** sa date : la Fed réutilise « Federal Reserve
issues FOMC statement » huit fois par an.

## Test en direct

Toute publication pertinente vue moins de 5 minutes après sa parution est enregistrée avec le
prix temps réel à la détection, puis le prix est relevé à +5 min, +15 min, +1 h et +4 h. Rien
n'est recalculé après coup : ni mémoire du modèle, ni connaissance du futur. C'est la mesure de
référence, à lire après quelques semaines.

## Interface

Portefeuille en direct, chandeliers temps réel (`1m` à `1D`) avec les seuils de la stratégie et
les ordres, replay animé des 3 ans (avec Jev, sans news, acheter et garder), test en direct,
ordres du bot, et publications jugées par Jev avec ses réponses. « Nouvelle simulation » repart
de 1 000 USDT sur les actifs cochés.

## Architecture

```
market.ts       bougies REST (+ historique paginé) et flux WebSocket de prix Binance, sans clé
news.ts         sources sondées : presse et primaires, texte complet quand il existe
brain.ts        questions TypeSafe, règles par source, appel à Jev
strategy.ts     biais news, tendance EMA avec hystérésis, décision
portfolio.ts    portefeuille papier : ordres au prix réel, frais, livre « tendance » et livre « événement »
events.ts       test en direct, règles du circuit immédiat, bilan
backtest.ts     rejoue `decide` bougie par bougie, avec ou sans les jugements d'époque
history.ts      archives : Wayback Machine, index de la Fed, archive des posts de Trump, API Binance
event-study.ts  étude d'événements sur l'historique
broker.ts       miroir optionnel des ordres sur le testnet Binance
bot.ts          boucles temps réel et état ; server.ts : API locale + flux SSE ; public/ : interface sans build
```

L'état est persisté dans `data/` (non versionné). Le journal des choix est dans `docs/design.md`.

## Limites

3 ans d'historique seulement (un cycle de hausse puis de baisse), actifs très corrélés, long
uniquement, pas de glissement simulé. Un modèle entraîné après coup peut connaître la suite de
certains événements, d'où le test en direct. Le serveur n'écoute que sur `127.0.0.1`, sans
authentification : ne pas l'exposer tel quel.
