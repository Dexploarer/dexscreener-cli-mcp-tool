import { describe, it, expect } from "vitest";
import { scoreHotness, scoreHotnessDetail, buildDistributionHeuristics } from "./scoring.js";
import { makePair, makeCandidate } from "./test-helpers.js";

describe("scoreHotness", () => {
  it("returns a score between 0 and 1", () => {
    const pair = makePair();
    const { score } = scoreHotness(pair);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher volume/liquidity/txns produce higher scores", () => {
    const weak = makePair({
      volumeH24: 1_000,
      liquidityUsd: 500,
      buysH1: 2,
      sellsH1: 1,
      volumeH1: 100,
      volumeM5: 10,
      marketCap: 5_000,
    });
    const strong = makePair({
      volumeH24: 500_000,
      liquidityUsd: 200_000,
      buysH1: 200,
      sellsH1: 80,
      volumeH1: 80_000,
      volumeM5: 10_000,
      marketCap: 5_000_000,
    });

    const { score: weakScore } = scoreHotness(weak);
    const { score: strongScore } = scoreHotness(strong);
    expect(strongScore).toBeGreaterThan(weakScore);
  });
});

describe("scoreHotnessDetail", () => {
  it("returns score, tags, and components", () => {
    const pair = makePair();
    const result = scoreHotnessDetail(pair);

    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("tags");
    expect(result).toHaveProperty("components");
    expect(typeof result.components.volume).toBe("number");
    expect(typeof result.components.liquidity).toBe("number");
    expect(typeof result.components.txns).toBe("number");
  });

  it("tags new_pair for pairs < 24h old", () => {
    const pair = makePair({ pairCreatedAtMs: Date.now() - 6 * 3_600_000 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("new_pair");
  });

  it("does not tag new_pair for pairs > 24h old", () => {
    const pair = makePair({ pairCreatedAtMs: Date.now() - 48 * 3_600_000 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).not.toContain("new_pair");
  });

  it("tags high_holders when holdersCount > 500", () => {
    const pair = makePair({ holdersCount: 1000 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("high_holders");
  });

  it("tags buy_heavy when buy ratio > 0.65", () => {
    const pair = makePair({ buysH1: 80, sellsH1: 20 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("buy_heavy");
  });

  it("tags pumping when priceChangeH1 > 10", () => {
    const pair = makePair({ priceChangeH1: 15 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("pumping");
  });

  it("tags dumping when priceChangeH1 < -10", () => {
    const pair = makePair({ priceChangeH1: -15 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("dumping");
  });

  it("tags accelerating when h1/h24 ratio > 0.3", () => {
    const pair = makePair({ buysH1: 50, sellsH1: 50, buysH24: 100, sellsH24: 100 });
    const { tags } = scoreHotnessDetail(pair);
    expect(tags).toContain("accelerating");
  });

  it("clamps score to [0, 1]", () => {
    // Extremely negative values
    const pair = makePair({ priceChangeH1: -100 });
    const { score } = scoreHotnessDetail(pair);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("buildDistributionHeuristics", () => {
  it("returns expected keys", () => {
    const candidate = makeCandidate();
    const result = buildDistributionHeuristics(candidate);

    expect(result).toHaveProperty("volumeToLiquidity");
    expect(result).toHaveProperty("buyPressure");
    expect(result).toHaveProperty("spreadH1H24");
    expect(result).toHaveProperty("momentumM5H1");
    expect(result).toHaveProperty("holderScore");
    expect(result).toHaveProperty("ageScore");
    expect(result).toHaveProperty("txnsH1");
    expect(result).toHaveProperty("txnsH24");
    expect(result).toHaveProperty("ageHours");
    expect(result).toHaveProperty("boostTotal");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("discovery");
  });

  it("shows ageHours as 'unknown' when pairCreatedAtMs is null", () => {
    const candidate = makeCandidate({ pairCreatedAtMs: null });
    const result = buildDistributionHeuristics(candidate);
    expect(result.ageHours).toBe("unknown");
  });

  it("shows hasProfile as 1 or 0", () => {
    const withProfile = makeCandidate({}, { hasProfile: true });
    const withoutProfile = makeCandidate({}, { hasProfile: false });

    expect(buildDistributionHeuristics(withProfile).hasProfile).toBe(1);
    expect(buildDistributionHeuristics(withoutProfile).hasProfile).toBe(0);
  });
});
