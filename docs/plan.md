# Plan d'implémentation v1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** bot TypeScript qui lit le marché Binance, fait juger les news par Jev (TypeSafe) et passe des ordres simulés sur le testnet.

**Architecture:** modules indépendants (`market`, `news`, `brain`, `strategy`, `broker`) orchestrés par `index.ts`. Jev ne fait que des jugements typés par titre ; toute la décision est en code.

**Tech Stack:** Node 22, TypeScript strict, `@typesafe-ai/sdk` 0.6, `fast-xml-parser`, `vitest`, `tsx`.

**Spec:** `docs/design.md`

## Global Constraints

- Commentaires : une ligne max, en français, uniquement où c'est essentiel.
- Questions TypeSafe rédigées en anglais (les titres RSS sont en anglais).
- Aucune lib Binance : `fetch` natif + `node:crypto`.
- `--dry-run` par défaut ; `--live` requis pour passer un ordre.
- Commits Conventional Commits en anglais, sans co-auteur.

---

### Task 1: `config.ts`
**Files:** Create `src/config.ts`
**Produces:** `config` : `{ symbols: string[]; orderUsdt; intervalMin; live; once; weights: {news, tech}; thresholds: {buy, sell, minConfidence, minHeadlines, regulatoryRisk}; binance: {data, testnet, key, secret} }`.
- [ ] Écrire le module (lecture `process.env`, flags argv). Pas de test (pure config).

### Task 2: `market.ts` — données réelles + indicateurs
**Files:** Create `src/market.ts`, `tests/market.test.ts`
**Produces:** `type Candle = {time; close}`, `type MarketSnapshot = {symbol; price; change24h; sma24; signal}`, `sma(values, period)`, `techSignal(candles): MarketSnapshot sans symbol`, `fetchCandles(symbol, limit)`, `marketSnapshot(symbol)`.
- [ ] Test : `sma([1,2,3,4], 2) === 3.5` ; `techSignal` renvoie `signal` borné à [-1,1] et positif quand prix > SMA.
- [ ] Implémenter, `npm test`, commit `feat: add binance market data and tech signal`.

### Task 3: `news.ts` — RSS
**Files:** Create `src/news.ts`, `tests/news.test.ts`
**Produces:** `type Headline = {title; source; publishedAt}`, `parseRss(xml, source): Headline[]`, `fetchHeadlines(limit): Promise<Headline[]>` (CoinDesk + Cointelegraph, dédup par titre, triés par date).
- [ ] Test : `parseRss` sur un XML minimal renvoie titres/dates ; dédoublonnage.
- [ ] Implémenter, tester, commit `feat: fetch crypto headlines from rss feeds`.

### Task 4: `brain.ts` — questions TypeSafe
**Files:** Create `src/brain.ts`, `tests/brain.test.ts`
**Produces:** `questions` (asset Choice, sentiment Score 5 niveaux, material Noul, regulatory_risk Noul), `type Judgment = {headline; asset: "BTC"|"ETH"|"crypto"|"unrelated"; assetConfidence; sentiment (-1..1); sentimentConfidence; material; regulatoryRisk}`, `toJudgment(headline, answers)`, `judgeHeadlines(headlines, client?)`.
- [ ] Test : `toJudgment` normalise `score 3.0` → `sentiment 0.5`, recopie `choice`/`confidence`/`noul`.
- [ ] Implémenter (une requête `systemOne` par titre, `Promise.all`), tester, commit `feat: judge headlines with typesafe jev`.

### Task 5: `strategy.ts` — décision en code
**Files:** Create `src/strategy.ts`, `tests/strategy.test.ts`
**Produces:** `type Decision = {symbol; action: "BUY"|"SELL"|"HOLD"; score; newsScore: number|null; techSignal; headlinesUsed; reason}`, `newsScore(judgments, base)`, `decide(market, judgments, cfg?)`.
- [ ] Tests : filtre `unrelated` et faible confiance ; pondération material×confidence ; `HOLD` si < `minHeadlines` ; `BUY` bloqué si `regulatoryRisk` ≥ seuil ; seuils buy/sell.
- [ ] Implémenter, tester, commit `feat: composite scoring strategy with confidence gating`.

### Task 6: `broker.ts` — testnet Binance
**Files:** Create `src/broker.ts`, `tests/broker.test.ts`
**Produces:** `sign(query, secret)`, `getBalances()`, `positionValue(symbol, price)`, `placeMarketOrder(symbol, side, quoteUsdt)`.
- [ ] Test : `sign` sur le vecteur officiel de la doc Binance.
- [ ] Implémenter (`X-MBX-APIKEY`, `timestamp`, `signature`), tester, commit `feat: binance testnet broker with signed orders`.

### Task 7: `index.ts` + README + run réel
**Files:** Create `src/index.ts`, `README.md`
- [ ] Cycle : snapshot par symbole → titres → jugements → décision → exécution si `--live` → table console + JSON dans `logs/`.
- [ ] `npm run typecheck`, `npm test`, `npm start -- --once` (dry-run) puis `--once --live` sur testnet.
- [ ] README (setup clés, commandes, notions TypeSafe), commit `feat: bot loop, journal and readme`, repo GitHub public.
