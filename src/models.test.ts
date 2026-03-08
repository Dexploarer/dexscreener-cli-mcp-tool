import { describe, it, expect } from "vitest";
import {
  parsePairSnapshot,
  txnsH1,
  txnsH24,
  ageHours,
  pairKey,
  computeCandidateAnalytics,
  hotTokenKey,
} from "./models.js";
import { makePair, makeCandidate } from "./test-helpers.js";

describe("parsePairSnapshot", () => {
  it("parses a full API payload", () => {
    const raw = {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "0xabc",
      url: "https://dexscreener.com/solana/0xabc",
      baseToken: { address: "0xtoken", symbol: "FOO", name: "FooCoin" },
      quoteToken: { symbol: "SOL" },
      priceUsd: "0.042",
      volume: { h24: 120000, h6: 50000, h1: 8000, m5: 1500 },
      txns: { h1: { buys: 45, sells: 22 }, h24: { buys: 300, sells: 250 } },
      priceChange: { h1: 7.5, h24: -3.2 },
      liquidity: { usd: 80000 },
      marketCap: 2000000,
      fdv: 2500000,
      holdersCount: 1200,
      holdersSource: "geckoterminal",
      pairCreatedAt: 1700000000000,
    };

    const snap = parsePairSnapshot(raw);

    expect(snap.chainId).toBe("solana");
    expect(snap.dexId).toBe("raydium");
    expect(snap.pairAddress).toBe("0xabc");
    expect(snap.baseSymbol).toBe("FOO");
    expect(snap.baseName).toBe("FooCoin");
    expect(snap.quoteSymbol).toBe("SOL");
    expect(snap.priceUsd).toBeCloseTo(0.042);
    expect(snap.volumeH24).toBe(120000);
    expect(snap.volumeH6).toBe(50000);
    expect(snap.volumeH1).toBe(8000);
    expect(snap.volumeM5).toBe(1500);
    expect(snap.buysH1).toBe(45);
    expect(snap.sellsH1).toBe(22);
    expect(snap.buysH24).toBe(300);
    expect(snap.sellsH24).toBe(250);
    expect(snap.priceChangeH1).toBeCloseTo(7.5);
    expect(snap.priceChangeH24).toBeCloseTo(-3.2);
    expect(snap.liquidityUsd).toBe(80000);
    expect(snap.marketCap).toBe(2000000);
    expect(snap.holdersCount).toBe(1200);
    expect(snap.holdersSource).toBe("geckoterminal");
    expect(snap.pairCreatedAtMs).toBe(1700000000000);
    expect(snap.raw).toBe(raw);
  });

  it("handles missing/null fields gracefully", () => {
    const snap = parsePairSnapshot({});

    expect(snap.chainId).toBe("");
    expect(snap.baseSymbol).toBe("");
    expect(snap.priceUsd).toBe(0);
    expect(snap.volumeH24).toBe(0);
    expect(snap.buysH1).toBe(0);
    expect(snap.sellsH1).toBe(0);
    expect(snap.holdersCount).toBeNull();
    expect(snap.pairCreatedAtMs).toBeNull();
  });

  it("parses string numbers", () => {
    const snap = parsePairSnapshot({
      priceUsd: "1.23",
      volume: { h24: "99999" },
      txns: { h1: { buys: "10", sells: "5" } },
    });

    expect(snap.priceUsd).toBeCloseTo(1.23);
    expect(snap.volumeH24).toBe(99999);
    expect(snap.buysH1).toBe(10);
    expect(snap.sellsH1).toBe(5);
  });

  it("returns fallback for NaN values", () => {
    const snap = parsePairSnapshot({
      priceUsd: "not-a-number",
      volume: { h24: "abc" },
    });

    expect(snap.priceUsd).toBe(0);
    expect(snap.volumeH24).toBe(0);
  });
});

describe("txnsH1 / txnsH24", () => {
  it("sums buys and sells for H1", () => {
    const pair = makePair({ buysH1: 40, sellsH1: 20 });
    expect(txnsH1(pair)).toBe(60);
  });

  it("sums buys and sells for H24", () => {
    const pair = makePair({ buysH24: 300, sellsH24: 200 });
    expect(txnsH24(pair)).toBe(500);
  });
});

describe("ageHours", () => {
  it("returns null when pairCreatedAtMs is null", () => {
    const pair = makePair({ pairCreatedAtMs: null });
    expect(ageHours(pair)).toBeNull();
  });

  it("returns age in hours", () => {
    const sixHoursAgo = Date.now() - 6 * 3_600_000;
    const pair = makePair({ pairCreatedAtMs: sixHoursAgo });
    const age = ageHours(pair);
    expect(age).not.toBeNull();
    expect(age!).toBeCloseTo(6, 0);
  });
});

describe("pairKey / hotTokenKey", () => {
  it("returns [chainId, baseAddress]", () => {
    const pair = makePair({ chainId: "base", baseAddress: "0xabc" });
    expect(pairKey(pair)).toEqual(["base", "0xabc"]);
  });

  it("hotTokenKey delegates to pairKey", () => {
    const candidate = makeCandidate({ chainId: "ethereum", baseAddress: "0xdef" });
    expect(hotTokenKey(candidate)).toEqual(["ethereum", "0xdef"]);
  });
});

describe("computeCandidateAnalytics", () => {
  it("computes all analytics fields", () => {
    const pair = makePair({
      volumeH24: 200_000,
      liquidityUsd: 100_000,
      buysH1: 60,
      sellsH1: 40,
      priceChangeH1: 5,
      priceChangeH24: 10,
      volumeM5: 3_000,
      volumeH1: 18_000,
      holdersCount: 500,
      pairCreatedAtMs: Date.now() - 48 * 3_600_000,
    });

    const a = computeCandidateAnalytics(pair);

    expect(a.volumeToLiquidity).toBeCloseTo(2.0);
    expect(a.buyPressure).toBeCloseTo(0.6);
    expect(a.spreadH1H24).toBeCloseTo(0.5);
    expect(a.momentumM5H1).toBeCloseTo(2.0);
    expect(a.holderScore).toBeCloseTo(0.5);
    expect(a.ageScore).toBeCloseTo(48 / 168, 1);
  });

  it("handles zero liquidity", () => {
    const pair = makePair({ liquidityUsd: 0, volumeH24: 100 });
    const a = computeCandidateAnalytics(pair);
    expect(a.volumeToLiquidity).toBe(100); // volumeH24 / 1
  });

  it("handles null holders", () => {
    const pair = makePair({ holdersCount: null });
    const a = computeCandidateAnalytics(pair);
    expect(a.holderScore).toBe(0);
  });

  it("handles null pairCreatedAtMs", () => {
    const pair = makePair({ pairCreatedAtMs: null });
    const a = computeCandidateAnalytics(pair);
    expect(a.ageScore).toBe(0.5);
  });

  it("caps holderScore at 1", () => {
    const pair = makePair({ holdersCount: 5000 });
    const a = computeCandidateAnalytics(pair);
    expect(a.holderScore).toBe(1);
  });
});
