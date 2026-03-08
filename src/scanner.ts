import { DexplorerClient } from "./client.js";
import { ScanFilters } from "./config.js";
import { hydratePairHolders } from "./holders.js";
import {
  CandidateAnalytics,
  HotTokenCandidate,
  PairSnapshot,
  parsePairSnapshot,
  txnsH1,
  ageHours,
  pairKey,
} from "./models.js";
import { scoreHotnessDetail } from "./scoring.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SeedToken {
  chainId: string;
  tokenAddress: string;
  boostTotal: number;
  boostCount: number;
  hasProfile: boolean;
  discovery: string;
}

interface RiskProfile {
  riskScore: number;
  riskPenalty: number;
  riskFlags: string[];
}

interface CompressionResult {
  compressionScore: number;
  breakoutReadiness: number;
}

interface MomentumResult {
  halfLifeMin: number | null;
  decayRatio: number | null;
  fastDecay: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function seedSortKey(s: SeedToken): number {
  return s.boostTotal * 1e6 + s.boostCount * 1e3 + (s.hasProfile ? 1 : 0);
}

function candidateKey(c: HotTokenCandidate): string {
  return `${c.pair.chainId}:${c.pair.baseAddress}`;
}

function asFloat(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return isNaN(n) ? 0 : n;
}

function asInt(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// HotScanner
// ---------------------------------------------------------------------------

export class HotScanner {
  private readonly client: DexplorerClient;
  private readonly boostHistory = new Map<string, [number, number]>();
  private readonly momentumHistory = new Map<string, [number, number][]>();
  private readonly maxHistoryPoints = 20;
  private readonly historyTtlSeconds = 2 * 60 * 60;
  private readonly maxHistoryKeys = 2_000;

  constructor(client: DexplorerClient) {
    this.client = client;
  }

  // ── Static helpers ──────────────────────────────────────────────

  static clip(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
  }

  static buyPressure(pair: PairSnapshot): number {
    const t = txnsH1(pair);
    if (t <= 0) return 0;
    return (pair.buysH1 - pair.sellsH1) / t;
  }

  static riskProfile(pair: PairSnapshot): RiskProfile {
    let riskScore = 100;
    const flags: string[] = [];

    const volLiq = pair.volumeH24 / Math.max(pair.liquidityUsd, 1);
    if (pair.liquidityUsd < 20_000) {
      riskScore -= 18;
      flags.push("low-liquidity");
    }
    if (volLiq >= 80) {
      riskScore -= 12;
      flags.push("high-turnover");
    }
    if (volLiq >= 140) {
      riskScore -= 24;
      flags.push("thin-exit");
    }

    const mcap = pair.marketCap > 0 ? pair.marketCap : pair.fdv;
    if (mcap > 0) {
      const liqToCap = pair.liquidityUsd / mcap;
      if (liqToCap < 0.02) {
        riskScore -= 15;
        flags.push("concentration-risk");
      }
    }

    const t1 = txnsH1(pair);
    if (t1 <= 2 && pair.volumeH24 >= 100_000) {
      riskScore -= 20;
      flags.push("low-participant-flow");
    }

    if (pair.priceChangeH1 >= 140 && t1 < 50) {
      riskScore -= 12;
      flags.push("blowoff-risk");
    }

    if (pair.buysH1 >= 20 && pair.sellsH1 === 0) {
      riskScore -= 18;
      flags.push("one-way-flow");
    }

    riskScore = Math.max(0, Math.min(100, riskScore));
    const riskPenalty = Math.max(0, (65 - riskScore) * 0.28);
    return { riskScore, riskPenalty, riskFlags: flags };
  }

  static velocityComponents(pair: PairSnapshot): [number, number] {
    let volBaseline: number;
    if (pair.volumeH6 > pair.volumeH1) {
      volBaseline = (pair.volumeH6 - pair.volumeH1) / 5;
    } else {
      volBaseline = pair.volumeH24 / 24;
    }
    volBaseline = Math.max(volBaseline, 1);
    const volumeVelocity = pair.volumeH1 / volBaseline;

    const txH24 = pair.buysH24 + pair.sellsH24;
    const t1 = txnsH1(pair);
    let txBaseline: number;
    if (txH24 > t1) {
      txBaseline = (txH24 - t1) / 23;
    } else {
      txBaseline = txH24 / 24;
    }
    txBaseline = Math.max(txBaseline, 1);
    const txnVelocity = t1 / txBaseline;

    return [volumeVelocity, txnVelocity];
  }

  static pairRank(pair: PairSnapshot): number {
    return (
      pair.liquidityUsd * 0.45 +
      pair.volumeH24 * 0.45 +
      txnsH1(pair) * 150 +
      pair.priceChangeH1 * 1500
    );
  }

  // ── Instance methods ────────────────────────────────────────────

  compressionAndReadiness(
    pair: PairSnapshot,
    bp: number,
    volumeVelocity: number,
    txnVelocity: number,
  ): CompressionResult {
    const priceNoise = Math.abs(pair.priceChangeH1);
    const compressionPrice = HotScanner.clip((9 - priceNoise) / 9, 0, 1);
    const flowBuild = HotScanner.clip(
      (Math.min(volumeVelocity, 3) / 3 + Math.min(txnVelocity, 3) / 3) / 2,
      0,
      1,
    );
    const pressure = HotScanner.clip((bp + 0.15) / 0.85, 0, 1);

    const compressionScore = HotScanner.clip(
      compressionPrice * 0.55 + flowBuild * 0.30 + pressure * 0.15,
      0,
      1,
    );
    const breakoutReadiness = HotScanner.clip(
      compressionScore * 0.45 +
        (Math.min(volumeVelocity, 3) / 3) * 0.30 +
        (Math.min(txnVelocity, 3) / 3) * 0.15 +
        pressure * 0.10,
      0,
      1,
    );
    return {
      compressionScore: compressionScore * 100,
      breakoutReadiness: breakoutReadiness * 100,
    };
  }

  boostVelocity(key: string, boostTotal: number, nowS: number): number {
    const previous = this.boostHistory.get(key);
    this.boostHistory.set(key, [nowS, boostTotal]);
    if (previous == null) return 0;
    const dtMin = (nowS - previous[0]) / 60;
    if (dtMin <= 0) return 0;
    return (boostTotal - previous[1]) / dtMin;
  }

  momentumMetrics(
    key: string,
    priceChangeH1: number,
    nowS: number,
  ): MomentumResult {
    let history = this.momentumHistory.get(key) ?? [];
    history.push([nowS, Math.max(priceChangeH1, 0)]);
    const cutoff = nowS - this.historyTtlSeconds;
    history = history.filter(([ts]) => ts >= cutoff);
    if (history.length > this.maxHistoryPoints) {
      history = history.slice(-this.maxHistoryPoints);
    }
    this.momentumHistory.set(key, history);

    if (history.length < 2) {
      return { halfLifeMin: null, decayRatio: null, fastDecay: false };
    }

    let peakIdx = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i][1] > history[peakIdx][1]) peakIdx = i;
    }
    const [peakTs, peakVal] = history[peakIdx];
    if (peakVal <= 0) {
      return { halfLifeMin: null, decayRatio: null, fastDecay: false };
    }

    const currentVal = history[history.length - 1][1];
    const decayRatio = currentVal / peakVal;
    let halfLifeMin: number | null = null;
    const halfLevel = peakVal * 0.5;
    for (let i = peakIdx; i < history.length; i++) {
      if (history[i][1] <= halfLevel) {
        halfLifeMin = (history[i][0] - peakTs) / 60;
        break;
      }
    }

    const fastDecay =
      halfLifeMin != null && halfLifeMin <= 12 && decayRatio <= 0.45;
    return { halfLifeMin, decayRatio, fastDecay };
  }

  pruneHistories(nowS: number): void {
    const cutoff = nowS - this.historyTtlSeconds;

    // Prune stale boost entries
    for (const [key, [ts]] of this.boostHistory) {
      if (ts < cutoff) this.boostHistory.delete(key);
    }

    // Prune momentum history
    for (const [key, history] of this.momentumHistory) {
      let trimmed = history.filter(([ts]) => ts >= cutoff);
      if (trimmed.length === 0) {
        this.momentumHistory.delete(key);
        continue;
      }
      if (trimmed.length > this.maxHistoryPoints) {
        trimmed = trimmed.slice(-this.maxHistoryPoints);
      }
      this.momentumHistory.set(key, trimmed);
    }

    // Evict oldest boost keys if over limit
    if (this.boostHistory.size > this.maxHistoryKeys) {
      const sorted = [...this.boostHistory.entries()].sort(
        (a, b) => a[1][0] - b[1][0],
      );
      const toRemove = sorted.length - this.maxHistoryKeys;
      for (let i = 0; i < toRemove; i++) {
        this.boostHistory.delete(sorted[i][0]);
      }
    }

    // Evict oldest momentum keys if over limit
    if (this.momentumHistory.size > this.maxHistoryKeys) {
      const sorted = [...this.momentumHistory.entries()].sort((a, b) => {
        const aLast = a[1].length > 0 ? a[1][a[1].length - 1][0] : 0;
        const bLast = b[1].length > 0 ? b[1][b[1].length - 1][0] : 0;
        return aLast - bLast;
      });
      const toRemove = sorted.length - this.maxHistoryKeys;
      for (let i = 0; i < toRemove; i++) {
        this.momentumHistory.delete(sorted[i][0]);
      }
    }
  }

  enrichCandidates(candidates: HotTokenCandidate[]): void {
    if (candidates.length === 0) return;

    const nowS = Date.now() / 1000;
    this.pruneHistories(nowS);

    const chainMomentum = new Map<string, number[]>();
    const chainVelocity = new Map<string, number[]>();
    const metrics = new Map<
      string,
      [number, number, number, number, number]
    >();

    for (const candidate of candidates) {
      const pair = candidate.pair;
      const bp = HotScanner.buyPressure(pair);
      const [volumeVelocity, txnVelocity] = HotScanner.velocityComponents(pair);
      const { compressionScore, breakoutReadiness } =
        this.compressionAndReadiness(pair, bp, volumeVelocity, txnVelocity);

      const key = candidateKey(candidate);
      metrics.set(key, [
        bp,
        volumeVelocity,
        txnVelocity,
        compressionScore,
        breakoutReadiness,
      ]);

      if (!chainMomentum.has(pair.chainId)) chainMomentum.set(pair.chainId, []);
      chainMomentum.get(pair.chainId)!.push(pair.priceChangeH1);
      if (!chainVelocity.has(pair.chainId)) chainVelocity.set(pair.chainId, []);
      chainVelocity.get(pair.chainId)!.push(volumeVelocity);
    }

    const chainBaselineH1 = new Map<string, number>();
    for (const [chain, values] of chainMomentum) {
      if (values.length > 0) chainBaselineH1.set(chain, median(values));
    }
    const chainBaselineVelocity = new Map<string, number>();
    for (const [chain, values] of chainVelocity) {
      if (values.length > 0) chainBaselineVelocity.set(chain, median(values));
    }

    for (const candidate of candidates) {
      const pair = candidate.pair;
      const key = candidateKey(candidate);
      const baseScore = candidate.score;
      const [bp, volumeVelocity, txnVelocity, compressionScore, breakoutReadiness] =
        metrics.get(key)!;

      const baselineH1 = chainBaselineH1.get(pair.chainId) ?? 0;
      const baselineVelocity = chainBaselineVelocity.get(pair.chainId) ?? 1;
      const relativeStrength =
        (pair.priceChangeH1 - baselineH1) +
        (volumeVelocity - baselineVelocity) * 5;

      const { riskScore, riskPenalty, riskFlags } = HotScanner.riskProfile(pair);
      const bv = this.boostVelocity(key, candidate.boostTotal, nowS);
      const { halfLifeMin, decayRatio, fastDecay } = this.momentumMetrics(
        key,
        pair.priceChangeH1,
        nowS,
      );

      // Update analytics - adapt to the TS CandidateAnalytics interface
      // The TS interface has different fields than the Python dataclass,
      // so we store the enriched data in the available fields.
      candidate.analytics = {
        volumeToLiquidity: pair.volumeH24 / Math.max(pair.liquidityUsd, 1),
        buyPressure: bp,
        spreadH1H24:
          pair.priceChangeH1 !== 0 && pair.priceChangeH24 !== 0
            ? pair.priceChangeH1 / Math.abs(pair.priceChangeH24) || 0
            : 0,
        momentumM5H1: (pair.volumeM5 * 12) / Math.max(pair.volumeH1, 1),
        holderScore:
          pair.holdersCount != null
            ? Math.min(pair.holdersCount / 1000, 1)
            : 0,
        ageScore: (() => {
          const age = ageHours(pair);
          return age != null ? Math.min(age / 168, 1) : 0.5;
        })(),
      };

      // Adjust score
      let adjusted = candidate.score;
      adjusted += (breakoutReadiness - 50) * 0.08;
      adjusted += HotScanner.clip(relativeStrength, -25, 25) * 0.15;
      adjusted += HotScanner.clip(bv, -10, 10) * 0.2;
      adjusted -= riskPenalty;
      if (fastDecay) adjusted -= 12;
      candidate.score = Math.round(Math.max(0, adjusted) * 100) / 100;

      // Update tags
      const tags = [...candidate.tags];
      if (
        compressionScore >= 72 &&
        volumeVelocity >= 1.15 &&
        txnVelocity >= 1.15
      ) {
        tags.push("volatility-compression");
      }
      if (breakoutReadiness >= 68) tags.push("breakout-ready");
      if (relativeStrength >= 8) tags.push("rs-leader");
      else if (relativeStrength <= -8) tags.push("rs-laggard");
      if (bv >= 3) tags.push("boost-accel");
      else if (bv <= -1) tags.push("boost-decay");
      if (fastDecay) tags.push("momentum-decay");
      else if (
        halfLifeMin != null &&
        halfLifeMin >= 25 &&
        (decayRatio ?? 0) > 0.65
      ) {
        tags.push("momentum-persistent");
      }
      // Deduplicate while preserving order
      candidate.tags = [...new Map(tags.map((t) => [t, t])).keys()];
    }
  }

  // ── Seed collection ─────────────────────────────────────────────

  async collectSeeds(
    chains: string[],
  ): Promise<Map<string, SeedToken>> {
    const chainSet = new Set(chains);
    const [boostsTop, boostsLatest, profiles, takeovers] = await Promise.all([
      this.client.getTokenBoostsTop(),
      this.client.getTokenBoostsLatest(),
      this.client.getTokenProfilesLatest(),
      this.client.getCommunityTakeoversLatest(),
    ]);

    const seeds = new Map<string, SeedToken>();

    function upsert(
      chainId: string,
      tokenAddress: string,
      opts: {
        boostTotal?: number;
        boostCount?: number;
        hasProfile?: boolean;
        discovery?: string;
      } = {},
    ): void {
      const key = `${chainId}:${tokenAddress}`;
      const existing = seeds.get(key);
      if (existing == null) {
        seeds.set(key, {
          chainId,
          tokenAddress,
          boostTotal: opts.boostTotal ?? 0,
          boostCount: opts.boostCount ?? 0,
          hasProfile: opts.hasProfile ?? false,
          discovery: opts.discovery ?? "seed",
        });
        return;
      }
      existing.boostTotal += opts.boostTotal ?? 0;
      existing.boostCount += opts.boostCount ?? 0;
      existing.hasProfile = existing.hasProfile || (opts.hasProfile ?? false);
      if (existing.discovery === "seed" && opts.discovery && opts.discovery !== "seed") {
        existing.discovery = opts.discovery;
      }
    }

    for (const row of boostsTop) {
      const chainId = String(row.chainId ?? "");
      const token = String(row.tokenAddress ?? "");
      if (!chainSet.has(chainId) || !token) continue;
      upsert(chainId, token, {
        boostTotal: asFloat(row.totalAmount),
        boostCount: 1,
        discovery: "top-boosts",
      });
    }

    const latestCounter = new Map<string, number>();
    for (const row of boostsLatest) {
      const chainId = String(row.chainId ?? "");
      const token = String(row.tokenAddress ?? "");
      if (!chainSet.has(chainId) || !token) continue;
      const lk = `${chainId}:${token}`;
      latestCounter.set(lk, (latestCounter.get(lk) ?? 0) + 1);
      upsert(chainId, token, {
        boostTotal: asFloat(row.totalAmount),
        boostCount: 1,
        discovery: "latest-boosts",
      });
    }

    for (const row of profiles) {
      const chainId = String(row.chainId ?? "");
      const token = String(row.tokenAddress ?? "");
      if (!chainSet.has(chainId) || !token) continue;
      upsert(chainId, token, { hasProfile: true, discovery: "profiles" });
    }

    for (const row of takeovers) {
      const chainId = String(row.chainId ?? "");
      const token = String(row.tokenAddress ?? "");
      if (!chainSet.has(chainId) || !token) continue;
      upsert(chainId, token, {
        boostTotal: 45,
        boostCount: 1,
        hasProfile: true,
        discovery: "community",
      });
    }

    for (const [key, count] of latestCounter) {
      const seed = seeds.get(key);
      if (seed) seed.boostCount = Math.max(seed.boostCount, count);
    }

    // Search-based discovery layer
    const nowMs = Date.now();
    const TRENDING_QUERIES = [
      "pepe", "meme", "pump", "moon", "degen",
      "ai", "agent", "cat", "dog", "frog",
      "new token", "100x", "gem",
      "brett", "bonk", "floki", "shib",
      "virtual", "aero", "toshi", "normie",
      "well", "higher", "based",
      "weth", "cbbtc", "usdc",
    ];

    const searchResults = await Promise.all(
      TRENDING_QUERIES.map((q) =>
        this.client.searchPairs(q).catch(() => [] as Record<string, unknown>[]),
      ),
    );

    for (const batch of searchResults) {
      for (const row of batch) {
        const chainId = String((row as any).chainId ?? "");
        if (!chainSet.has(chainId)) continue;
        const base = (row as any).baseToken ?? {};
        const token = String(base.address ?? "");
        if (!token) continue;

        const txH1Raw = (row as any).txns?.h1 ?? {};
        const buysH1 = asInt(txH1Raw.buys);
        const sellsH1 = asInt(txH1Raw.sells);
        const tH1 = buysH1 + sellsH1;
        const volumeH24 = asFloat(((row as any).volume ?? {}).h24);
        const liquidityUsd = asFloat(((row as any).liquidity ?? {}).usd);
        const pairCreatedAt = (row as any).pairCreatedAt;

        let freshnessBonus = 0;
        if (pairCreatedAt != null) {
          const ageH = Math.max((nowMs - asInt(pairCreatedAt)) / 3_600_000, 0);
          freshnessBonus = Math.max(0, (168 - ageH) / 168) * 60;
        }

        const searchWeight =
          Math.min(volumeH24 / 100_000, 25) +
          Math.min(liquidityUsd / 50_000, 15) +
          Math.min(tH1 / 25, 20) +
          freshnessBonus;

        upsert(chainId, token, {
          boostTotal: searchWeight,
          boostCount: 1,
          discovery: "search",
        });
      }
    }

    return seeds;
  }

  // ── Pair fetching ───────────────────────────────────────────────

  private bestPairFromRows(
    rows: Record<string, unknown>[],
  ): Map<string, PairSnapshot> {
    const best = new Map<string, PairSnapshot>();
    for (const row of rows) {
      const pair = parsePairSnapshot(row as Record<string, any>);
      const key = `${pair.chainId}:${pair.baseAddress}`;
      const existing = best.get(key);
      if (existing == null || HotScanner.pairRank(pair) > HotScanner.pairRank(existing)) {
        best.set(key, pair);
      }
    }
    return best;
  }

  async prefetchPairsForSeeds(
    seeds: SeedToken[],
  ): Promise<Map<string, PairSnapshot>> {
    const byChain = new Map<string, string[]>();
    for (const seed of seeds) {
      if (!byChain.has(seed.chainId)) byChain.set(seed.chainId, []);
      byChain.get(seed.chainId)!.push(seed.tokenAddress);
    }

    const allRows: Record<string, unknown>[] = [];
    for (const [chainId, tokenAddresses] of byChain) {
      try {
        const rows = await this.client.getPairsForTokens(chainId, tokenAddresses);
        allRows.push(...rows);
      } catch {
        continue;
      }
    }

    return this.bestPairFromRows(allRows);
  }

  async bestPairForToken(
    chainId: string,
    tokenAddress: string,
  ): Promise<PairSnapshot | null> {
    const rows = await this.client.getTokenPairs(chainId, tokenAddress);
    if (rows.length === 0) return null;
    const pairs = rows.map((r) => parsePairSnapshot(r as Record<string, any>));
    pairs.sort((a, b) => HotScanner.pairRank(b) - HotScanner.pairRank(a));
    return pairs[0];
  }

  passesFilters(pair: PairSnapshot, filters: ScanFilters): boolean {
    if (pair.liquidityUsd < filters.minLiquidityUsd) return false;
    if (pair.volumeH24 < filters.minVolumeH24Usd) return false;
    if (txnsH1(pair) < filters.minTxnsH1) return false;
    if (pair.priceChangeH1 < filters.minPriceChangeH1) return false;
    return true;
  }

  // ── Main scan ───────────────────────────────────────────────────

  async scan(filters: ScanFilters): Promise<HotTokenCandidate[]> {
    const seeds = await this.collectSeeds(filters.chains);
    const target = Math.min(Math.max(filters.limit * 4, 12), 72);
    const numChains = filters.chains.length;

    const allSorted = [...seeds.values()].sort(
      (a, b) => seedSortKey(b) - seedSortKey(a),
    );

    let orderedSeeds: SeedToken[];

    if (numChains > 1) {
      const perChainMin = Math.max(
        Math.min(Math.floor(target / (numChains * 2)), 8),
        3,
      );
      const byChain = new Map<string, SeedToken[]>();
      for (const s of seeds.values()) {
        if (!byChain.has(s.chainId)) byChain.set(s.chainId, []);
        byChain.get(s.chainId)!.push(s);
      }
      for (const chainSeeds of byChain.values()) {
        chainSeeds.sort((a, b) => seedSortKey(b) - seedSortKey(a));
      }

      const selected: SeedToken[] = [];
      const seen = new Set<string>();

      // Round 1: guarantee minimum per chain
      for (const chainId of filters.chains) {
        const chainSeeds = byChain.get(chainId) ?? [];
        for (const s of chainSeeds.slice(0, perChainMin)) {
          const key = `${s.chainId}:${s.tokenAddress}`;
          if (!seen.has(key)) {
            selected.push(s);
            seen.add(key);
          }
        }
      }

      // Round 2: fill remaining slots
      for (const s of allSorted) {
        if (selected.length >= target) break;
        const key = `${s.chainId}:${s.tokenAddress}`;
        if (!seen.has(key)) {
          selected.push(s);
          seen.add(key);
        }
      }

      orderedSeeds = selected;
    } else {
      orderedSeeds = allSorted.slice(0, target);
    }

    const prefetch = await this.prefetchPairsForSeeds(orderedSeeds);
    const results: HotTokenCandidate[] = [];

    // Use Promise.all - the client already has rate limiting built in
    const workers = orderedSeeds.map(async (seed) => {
      let pair = prefetch.get(`${seed.chainId}:${seed.tokenAddress}`);
      if (pair == null) {
        pair = await this.bestPairForToken(seed.chainId, seed.tokenAddress) ?? undefined;
      }
      if (!pair) return;
      if (!this.passesFilters(pair, filters)) return;

      const detail = scoreHotnessDetail(pair);
      const analytics: CandidateAnalytics = {
        volumeToLiquidity: pair.volumeH24 / Math.max(pair.liquidityUsd, 1),
        buyPressure: HotScanner.buyPressure(pair),
        spreadH1H24:
          pair.priceChangeH1 !== 0 && pair.priceChangeH24 !== 0
            ? pair.priceChangeH1 / Math.abs(pair.priceChangeH24) || 0
            : 0,
        momentumM5H1: (pair.volumeM5 * 12) / Math.max(pair.volumeH1, 1),
        holderScore:
          pair.holdersCount != null
            ? Math.min(pair.holdersCount / 1000, 1)
            : 0,
        ageScore: (() => {
          const age = ageHours(pair!);
          return age != null ? Math.min(age / 168, 1) : 0.5;
        })(),
      };

      results.push({
        pair,
        score: detail.score,
        boostTotal: seed.boostTotal,
        boostCount: seed.boostCount,
        hasProfile: seed.hasProfile,
        discovery: seed.discovery,
        tags: detail.tags,
        analytics,
      });
    });

    await Promise.all(workers);

    // Deduplicate per token, keep strongest
    const dedup = new Map<string, HotTokenCandidate>();
    for (const candidate of results) {
      const key = candidateKey(candidate);
      const existing = dedup.get(key);
      if (existing == null || candidate.score > existing.score) {
        dedup.set(key, candidate);
      }
    }

    const enriched = [...dedup.values()];
    this.enrichCandidates(enriched);

    const ranked = enriched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((b.analytics as any).breakoutReadiness !== (a.analytics as any).breakoutReadiness) {
        return ((b.analytics as any).breakoutReadiness ?? 0) - ((a.analytics as any).breakoutReadiness ?? 0);
      }
      if (b.pair.volumeH24 !== a.pair.volumeH24) return b.pair.volumeH24 - a.pair.volumeH24;
      if (txnsH1(b.pair) !== txnsH1(a.pair)) return txnsH1(b.pair) - txnsH1(a.pair);
      return b.pair.liquidityUsd - a.pair.liquidityUsd;
    });

    const top = ranked.slice(0, filters.limit);
    await hydratePairHolders(
      top.map((c) => c.pair),
      filters.limit,
    );
    return top;
  }

  // ── Inspection / search ─────────────────────────────────────────

  async inspectToken(
    chainId: string,
    tokenAddress: string,
  ): Promise<PairSnapshot[]> {
    const rows = await this.client.getTokenPairs(chainId, tokenAddress);
    const snapshots = rows.map((r) =>
      parsePairSnapshot(r as Record<string, any>),
    );
    snapshots.sort((a, b) => {
      if (b.liquidityUsd !== a.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
      if (b.volumeH24 !== a.volumeH24) return b.volumeH24 - a.volumeH24;
      return txnsH1(b) - txnsH1(a);
    });
    await hydratePairHolders(snapshots, Math.min(snapshots.length, 12));
    return snapshots;
  }

  async inspectPair(
    chainId: string,
    pairAddress: string,
  ): Promise<PairSnapshot | null> {
    const row = await this.client.getPair(chainId, pairAddress);
    if (!row || Object.keys(row).length === 0) return null;
    const pair = parsePairSnapshot(row as Record<string, any>);
    await hydratePairHolders([pair], 1);
    return pair;
  }

  async search(query: string, limit: number = 20): Promise<PairSnapshot[]> {
    const rows = await this.client.searchPairs(query);
    const snapshots = rows
      .slice(0, limit)
      .map((r) => parsePairSnapshot(r as Record<string, any>));
    await hydratePairHolders(snapshots, Math.min(limit, 20));
    return snapshots;
  }
}
