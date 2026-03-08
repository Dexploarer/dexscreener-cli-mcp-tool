import type { PairSnapshot, HotTokenCandidate, CandidateAnalytics } from "./models.js";
import type { ScanTask } from "./state.js";

export function makePair(overrides: Partial<PairSnapshot> = {}): PairSnapshot {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "0xpair123",
    pairUrl: "https://dexscreener.com/solana/0xpair123",
    baseAddress: "0xtoken456",
    baseSymbol: "TEST",
    baseName: "Test Token",
    quoteSymbol: "SOL",
    priceUsd: 0.05,
    volumeH24: 100_000,
    volumeH6: 40_000,
    volumeH1: 15_000,
    volumeM5: 2_000,
    buysH1: 50,
    sellsH1: 30,
    buysH24: 400,
    sellsH24: 300,
    priceChangeH1: 5.0,
    priceChangeH24: 12.0,
    liquidityUsd: 50_000,
    marketCap: 1_000_000,
    fdv: 1_200_000,
    holdersCount: null,
    holdersSource: null,
    pairCreatedAtMs: Date.now() - 12 * 3_600_000, // 12 hours ago
    raw: {},
    ...overrides,
  };
}

export function makeCandidate(
  pairOverrides: Partial<PairSnapshot> = {},
  candidateOverrides: Partial<HotTokenCandidate> = {},
): HotTokenCandidate {
  const pair = makePair(pairOverrides);
  const analytics: CandidateAnalytics = {
    volumeToLiquidity: pair.volumeH24 / Math.max(pair.liquidityUsd, 1),
    buyPressure: pair.buysH1 / (pair.buysH1 + pair.sellsH1 || 1),
    spreadH1H24: 0,
    momentumM5H1: 0,
    holderScore: 0,
    ageScore: 0.5,
  };
  return {
    pair,
    score: 65,
    boostTotal: 100,
    boostCount: 2,
    hasProfile: true,
    discovery: "top-boosts",
    tags: [],
    analytics,
    ...candidateOverrides,
  };
}

export function makeTask(overrides: Partial<ScanTask> = {}): ScanTask {
  return {
    id: "task123",
    name: "test-task",
    preset: null,
    filters: null,
    intervalSeconds: null,
    alerts: null,
    status: "todo",
    notes: "",
    createdAt: "2025-01-01T00:00:00+00:00",
    updatedAt: "2025-01-01T00:00:00+00:00",
    lastRunAt: null,
    lastAlertAt: null,
    ...overrides,
  };
}
