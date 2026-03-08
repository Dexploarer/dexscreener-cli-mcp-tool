import { describe, it, expect } from "vitest";
import { HotScanner } from "./scanner.js";
import { DexplorerClient } from "./client.js";
import { makePair, makeCandidate } from "./test-helpers.js";

// We only test static/pure methods and instance methods that don't hit the API

describe("HotScanner.clip", () => {
  it("clips value to range", () => {
    expect(HotScanner.clip(5, 0, 10)).toBe(5);
    expect(HotScanner.clip(-5, 0, 10)).toBe(0);
    expect(HotScanner.clip(15, 0, 10)).toBe(10);
    expect(HotScanner.clip(0, 0, 1)).toBe(0);
    expect(HotScanner.clip(1, 0, 1)).toBe(1);
  });
});

describe("HotScanner.buyPressure", () => {
  it("returns positive for more buys than sells", () => {
    const pair = makePair({ buysH1: 80, sellsH1: 20 });
    expect(HotScanner.buyPressure(pair)).toBeCloseTo(0.6);
  });

  it("returns negative for more sells than buys", () => {
    const pair = makePair({ buysH1: 20, sellsH1: 80 });
    expect(HotScanner.buyPressure(pair)).toBeCloseTo(-0.6);
  });

  it("returns 0 for no transactions", () => {
    const pair = makePair({ buysH1: 0, sellsH1: 0 });
    expect(HotScanner.buyPressure(pair)).toBe(0);
  });

  it("returns 0 for equal buys and sells", () => {
    const pair = makePair({ buysH1: 50, sellsH1: 50 });
    expect(HotScanner.buyPressure(pair)).toBe(0);
  });
});

describe("HotScanner.riskProfile", () => {
  it("returns 100 for a healthy pair", () => {
    const pair = makePair({
      liquidityUsd: 100_000,
      volumeH24: 200_000,
      buysH1: 100,
      sellsH1: 80,
      priceChangeH1: 5,
      marketCap: 5_000_000,
    });
    const { riskScore, riskFlags } = HotScanner.riskProfile(pair);
    expect(riskScore).toBe(100);
    expect(riskFlags).toEqual([]);
  });

  it("flags low liquidity", () => {
    const pair = makePair({ liquidityUsd: 5_000 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("low-liquidity");
  });

  it("flags high turnover", () => {
    const pair = makePair({ volumeH24: 5_000_000, liquidityUsd: 50_000 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("high-turnover");
  });

  it("flags thin exit for extreme turnover", () => {
    const pair = makePair({ volumeH24: 10_000_000, liquidityUsd: 50_000 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("thin-exit");
  });

  it("flags concentration risk when liq/mcap < 0.02", () => {
    const pair = makePair({ liquidityUsd: 10_000, marketCap: 1_000_000 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("concentration-risk");
  });

  it("flags low-participant-flow", () => {
    const pair = makePair({ buysH1: 1, sellsH1: 0, volumeH24: 200_000 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("low-participant-flow");
  });

  it("flags blowoff risk", () => {
    const pair = makePair({ priceChangeH1: 150, buysH1: 20, sellsH1: 10 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("blowoff-risk");
  });

  it("flags one-way-flow", () => {
    const pair = makePair({ buysH1: 30, sellsH1: 0 });
    const { riskFlags } = HotScanner.riskProfile(pair);
    expect(riskFlags).toContain("one-way-flow");
  });

  it("riskPenalty is 0 when riskScore >= 65", () => {
    const pair = makePair({
      liquidityUsd: 100_000,
      volumeH24: 200_000,
      buysH1: 100,
      sellsH1: 80,
      priceChangeH1: 5,
      marketCap: 5_000_000,
    });
    const { riskPenalty } = HotScanner.riskProfile(pair);
    expect(riskPenalty).toBe(0);
  });
});

describe("HotScanner.velocityComponents", () => {
  it("returns volume and txn velocity", () => {
    const pair = makePair({
      volumeH1: 20_000,
      volumeH6: 60_000,
      volumeH24: 200_000,
      buysH1: 50,
      sellsH1: 30,
      buysH24: 400,
      sellsH24: 300,
    });
    const [volV, txnV] = HotScanner.velocityComponents(pair);
    expect(volV).toBeGreaterThan(0);
    expect(txnV).toBeGreaterThan(0);
  });

  it("handles zero volumes gracefully", () => {
    const pair = makePair({
      volumeH1: 0,
      volumeH6: 0,
      volumeH24: 0,
      buysH1: 0,
      sellsH1: 0,
      buysH24: 0,
      sellsH24: 0,
    });
    const [volV, txnV] = HotScanner.velocityComponents(pair);
    expect(volV).toBe(0);
    expect(txnV).toBe(0);
  });
});

describe("HotScanner.pairRank", () => {
  it("higher liq + vol + txns = higher rank", () => {
    const weak = makePair({ liquidityUsd: 1000, volumeH24: 500, buysH1: 1, sellsH1: 0, priceChangeH1: 0 });
    const strong = makePair({ liquidityUsd: 100_000, volumeH24: 500_000, buysH1: 200, sellsH1: 100, priceChangeH1: 10 });
    expect(HotScanner.pairRank(strong)).toBeGreaterThan(HotScanner.pairRank(weak));
  });
});

describe("HotScanner instance methods", () => {
  let scanner: HotScanner;

  // Create scanner with a dummy client (we won't call API methods)
  beforeEach(() => {
    scanner = new HotScanner(new DexplorerClient(1));
  });

  describe("passesFilters", () => {
    const filters = {
      chains: ["solana"],
      limit: 20,
      minLiquidityUsd: 20_000,
      minVolumeH24Usd: 40_000,
      minTxnsH1: 30,
      minPriceChangeH1: -5,
    };

    it("passes for a qualifying pair", () => {
      const pair = makePair({
        liquidityUsd: 50_000,
        volumeH24: 100_000,
        buysH1: 25,
        sellsH1: 15,
        priceChangeH1: 2,
      });
      expect(scanner.passesFilters(pair, filters)).toBe(true);
    });

    it("fails on low liquidity", () => {
      const pair = makePair({ liquidityUsd: 5_000 });
      expect(scanner.passesFilters(pair, filters)).toBe(false);
    });

    it("fails on low volume", () => {
      const pair = makePair({ volumeH24: 10_000 });
      expect(scanner.passesFilters(pair, filters)).toBe(false);
    });

    it("fails on low txns", () => {
      const pair = makePair({ buysH1: 5, sellsH1: 3 });
      expect(scanner.passesFilters(pair, filters)).toBe(false);
    });

    it("fails on price change below min", () => {
      const pair = makePair({ priceChangeH1: -10 });
      expect(scanner.passesFilters(pair, filters)).toBe(false);
    });
  });

  describe("compressionAndReadiness", () => {
    it("returns values between 0 and 100", () => {
      const pair = makePair();
      const { compressionScore, breakoutReadiness } = scanner.compressionAndReadiness(pair, 0.3, 1.5, 1.5);
      expect(compressionScore).toBeGreaterThanOrEqual(0);
      expect(compressionScore).toBeLessThanOrEqual(100);
      expect(breakoutReadiness).toBeGreaterThanOrEqual(0);
      expect(breakoutReadiness).toBeLessThanOrEqual(100);
    });
  });

  describe("boostVelocity", () => {
    it("returns 0 on first call", () => {
      const v = scanner.boostVelocity("key1", 100, 1000);
      expect(v).toBe(0);
    });

    it("returns positive when boost increases", () => {
      scanner.boostVelocity("key1", 100, 1000);
      const v = scanner.boostVelocity("key1", 200, 1060); // +100 in 1 min
      expect(v).toBeCloseTo(100);
    });

    it("returns negative when boost decreases", () => {
      scanner.boostVelocity("key1", 200, 1000);
      const v = scanner.boostVelocity("key1", 100, 1060);
      expect(v).toBeCloseTo(-100);
    });
  });

  describe("momentumMetrics", () => {
    it("returns nulls on first call", () => {
      const result = scanner.momentumMetrics("m1", 10, 1000);
      expect(result.halfLifeMin).toBeNull();
      expect(result.decayRatio).toBeNull();
      expect(result.fastDecay).toBe(false);
    });

    it("tracks decay after peak", () => {
      scanner.momentumMetrics("m1", 20, 1000);
      scanner.momentumMetrics("m1", 8, 1600); // dropped to 40% of peak after 10 min
      const result = scanner.momentumMetrics("m1", 5, 2200); // dropped further

      expect(result.decayRatio).not.toBeNull();
      expect(result.decayRatio!).toBeLessThan(1);
    });
  });

  describe("enrichCandidates", () => {
    it("handles empty array", () => {
      scanner.enrichCandidates([]);
    });

    it("adjusts scores and adds tags", () => {
      const candidates = [
        makeCandidate({
          volumeH24: 300_000,
          liquidityUsd: 100_000,
          buysH1: 80,
          sellsH1: 20,
          priceChangeH1: 15,
          volumeH1: 50_000,
          volumeH6: 150_000,
          volumeM5: 8_000,
        }),
      ];

      scanner.enrichCandidates(candidates);
      // Score should be adjusted (may go up or down based on enrichment)
      expect(typeof candidates[0].score).toBe("number");
      expect(Array.isArray(candidates[0].tags)).toBe(true);
    });
  });
});

// Importing beforeEach at top is enough since vitest handles it globally
import { beforeEach } from "vitest";
