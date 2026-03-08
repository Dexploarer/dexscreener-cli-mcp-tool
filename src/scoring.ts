import { PairSnapshot, txnsH1, txnsH24, ageHours, HotTokenCandidate, CandidateAnalytics } from "./models.js";

interface ScoreResult {
  score: number;
  tags: string[];
}

interface ScoreDetailResult {
  score: number;
  tags: string[];
  components: Record<string, number>;
}

export function scoreHotness(pair: PairSnapshot): ScoreResult {
  const { score, tags } = scoreHotnessDetail(pair);
  return { score, tags };
}

export function scoreHotnessDetail(pair: PairSnapshot): ScoreDetailResult {
  const tags: string[] = [];
  const components: Record<string, number> = {};

  const volScore = Math.min(Math.log1p(pair.volumeH24) / Math.log1p(1_000_000), 1);
  components.volume = volScore;

  const liqScore = Math.min(Math.log1p(pair.liquidityUsd) / Math.log1p(500_000), 1);
  components.liquidity = liqScore;

  const t1 = txnsH1(pair);
  const txnScore = Math.min(Math.log1p(t1) / Math.log1p(500), 1);
  components.txns = txnScore;

  const totalH1 = t1 || 1;
  const buyRatio = pair.buysH1 / totalH1;
  const buyPressure = buyRatio > 0.5 ? (buyRatio - 0.5) * 2 : 0;
  components.buyPressure = buyPressure;

  const priceComp = Math.max(Math.min(pair.priceChangeH1 / 20, 1), -1);
  components.priceChange = priceComp;

  const h1 = pair.volumeH1 || 1;
  const momentumRaw = (pair.volumeM5 * 12) / h1;
  const momentum = Math.min(momentumRaw, 2) / 2;
  components.momentum = momentum;

  let mcapScore = 0;
  if (pair.marketCap > 0) {
    mcapScore = Math.min(Math.log1p(pair.marketCap) / Math.log1p(10_000_000), 1);
  }
  components.marketCap = mcapScore;

  const age = ageHours(pair);
  let ageBonus = 0;
  if (age != null && age < 24) {
    ageBonus = 1 - age / 24;
    tags.push("new_pair");
  }
  components.ageBonus = ageBonus;

  if (pair.holdersCount != null && pair.holdersCount > 500) {
    tags.push("high_holders");
  }

  const t24 = txnsH24(pair);
  if (t24 > 0 && t1 / t24 > 0.3) {
    tags.push("accelerating");
  }

  if (buyRatio > 0.65) {
    tags.push("buy_heavy");
  }

  if (pair.priceChangeH1 > 10) {
    tags.push("pumping");
  } else if (pair.priceChangeH1 < -10) {
    tags.push("dumping");
  }

  const score =
    volScore * 0.2 +
    liqScore * 0.15 +
    txnScore * 0.2 +
    buyPressure * 0.1 +
    Math.max(priceComp, 0) * 0.1 +
    momentum * 0.1 +
    mcapScore * 0.05 +
    ageBonus * 0.1;

  return { score: Math.max(0, Math.min(score, 1)), tags, components };
}

export function buildDistributionHeuristics(candidate: HotTokenCandidate): Record<string, number | string> {
  const pair = candidate.pair;
  const a = candidate.analytics;

  const t1 = txnsH1(pair);
  const t24 = txnsH24(pair);
  const age = ageHours(pair);

  return {
    volumeToLiquidity: round4(a.volumeToLiquidity),
    buyPressure: round4(a.buyPressure),
    spreadH1H24: round4(a.spreadH1H24),
    momentumM5H1: round4(a.momentumM5H1),
    holderScore: round4(a.holderScore),
    ageScore: round4(a.ageScore),
    txnsH1: t1,
    txnsH24: t24,
    ageHours: age != null ? round4(age) : "unknown",
    boostTotal: candidate.boostTotal,
    boostCount: candidate.boostCount,
    hasProfile: candidate.hasProfile ? 1 : 0,
    score: round4(candidate.score),
    discovery: candidate.discovery,
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
