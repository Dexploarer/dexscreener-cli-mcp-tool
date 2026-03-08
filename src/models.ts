function asFloat(value: unknown, fallback: number = 0): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return isNaN(n) ? fallback : n;
}

function asInt(value: unknown, fallback: number = 0): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  return isNaN(n) ? fallback : n;
}

function asIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  return isNaN(n) ? null : n;
}

export interface PairSnapshot {
  chainId: string;
  dexId: string;
  pairAddress: string;
  pairUrl: string;
  baseAddress: string;
  baseSymbol: string;
  baseName: string;
  quoteSymbol: string;
  priceUsd: number;
  volumeH24: number;
  volumeH6: number;
  volumeH1: number;
  volumeM5: number;
  buysH1: number;
  sellsH1: number;
  buysH24: number;
  sellsH24: number;
  priceChangeH1: number;
  priceChangeH24: number;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  holdersCount: number | null;
  holdersSource: string | null;
  pairCreatedAtMs: number | null;
  raw: Record<string, any>;
}

export function txnsH1(pair: PairSnapshot): number {
  return pair.buysH1 + pair.sellsH1;
}

export function txnsH24(pair: PairSnapshot): number {
  return pair.buysH24 + pair.sellsH24;
}

export function ageHours(pair: PairSnapshot): number | null {
  if (pair.pairCreatedAtMs == null) return null;
  return (Date.now() - pair.pairCreatedAtMs) / 3_600_000;
}

export function pairKey(pair: PairSnapshot): [string, string] {
  return [pair.chainId, pair.baseAddress];
}

export function parsePairSnapshot(payload: Record<string, any>): PairSnapshot {
  const volume = payload.volume ?? {};
  const txns = payload.txns ?? {};
  const txnsH1Data = txns.h1 ?? {};
  const txnsH24Data = txns.h24 ?? {};
  const priceChange = payload.priceChange ?? {};
  const liquidity = payload.liquidity ?? {};
  const baseToken = payload.baseToken ?? {};
  const quoteToken = payload.quoteToken ?? {};

  return {
    chainId: payload.chainId ?? "",
    dexId: payload.dexId ?? "",
    pairAddress: payload.pairAddress ?? "",
    pairUrl: payload.url ?? "",
    baseAddress: baseToken.address ?? "",
    baseSymbol: baseToken.symbol ?? "",
    baseName: baseToken.name ?? "",
    quoteSymbol: quoteToken.symbol ?? "",
    priceUsd: asFloat(payload.priceUsd),
    volumeH24: asFloat(volume.h24),
    volumeH6: asFloat(volume.h6),
    volumeH1: asFloat(volume.h1),
    volumeM5: asFloat(volume.m5),
    buysH1: asInt(txnsH1Data.buys),
    sellsH1: asInt(txnsH1Data.sells),
    buysH24: asInt(txnsH24Data.buys),
    sellsH24: asInt(txnsH24Data.sells),
    priceChangeH1: asFloat(priceChange.h1),
    priceChangeH24: asFloat(priceChange.h24),
    liquidityUsd: asFloat(liquidity.usd),
    marketCap: asFloat(payload.marketCap),
    fdv: asFloat(payload.fdv),
    holdersCount: asIntOrNull(payload.holdersCount),
    holdersSource: payload.holdersSource ?? null,
    pairCreatedAtMs: asIntOrNull(payload.pairCreatedAt),
    raw: payload,
  };
}

export interface CandidateAnalytics {
  volumeToLiquidity: number;
  buyPressure: number;
  spreadH1H24: number;
  momentumM5H1: number;
  holderScore: number;
  ageScore: number;
}

export function computeCandidateAnalytics(pair: PairSnapshot): CandidateAnalytics {
  const liq = pair.liquidityUsd || 1;
  const volumeToLiquidity = pair.volumeH24 / liq;

  const totalH1 = pair.buysH1 + pair.sellsH1 || 1;
  const buyPressure = pair.buysH1 / totalH1;

  const spreadH1H24 = pair.priceChangeH1 !== 0 && pair.priceChangeH24 !== 0
    ? pair.priceChangeH1 / Math.abs(pair.priceChangeH24) || 0
    : 0;

  const h1 = pair.volumeH1 || 1;
  const momentumM5H1 = (pair.volumeM5 * 12) / h1;

  const holders = pair.holdersCount;
  const holderScore = holders != null ? Math.min(holders / 1000, 1) : 0;

  const age = ageHours(pair);
  const ageScore = age != null ? Math.min(age / 168, 1) : 0.5;

  return {
    volumeToLiquidity,
    buyPressure,
    spreadH1H24,
    momentumM5H1,
    holderScore,
    ageScore,
  };
}

export interface HotTokenCandidate {
  pair: PairSnapshot;
  score: number;
  boostTotal: number;
  boostCount: number;
  hasProfile: boolean;
  discovery: string;
  tags: string[];
  analytics: CandidateAnalytics;
}

export function hotTokenKey(candidate: HotTokenCandidate): [string, string] {
  return pairKey(candidate.pair);
}
