import { describe, it, expect } from "vitest";
import {
  API_BASE,
  DEFAULT_CHAINS,
  RATE_LIMITS_RPM,
  MAX_RETRIES,
  defaultScanFilters,
} from "./config.js";

describe("constants", () => {
  it("API_BASE is the dexscreener endpoint", () => {
    expect(API_BASE).toBe("https://api.dexscreener.com");
  });

  it("DEFAULT_CHAINS includes expected chains", () => {
    expect(DEFAULT_CHAINS).toContain("solana");
    expect(DEFAULT_CHAINS).toContain("base");
    expect(DEFAULT_CHAINS).toContain("ethereum");
    expect(DEFAULT_CHAINS).toContain("bsc");
  });

  it("RATE_LIMITS_RPM has slow and fast buckets", () => {
    expect(RATE_LIMITS_RPM.slow).toBeGreaterThan(0);
    expect(RATE_LIMITS_RPM.fast).toBeGreaterThan(RATE_LIMITS_RPM.slow);
  });

  it("MAX_RETRIES is a positive number", () => {
    expect(MAX_RETRIES).toBeGreaterThan(0);
  });
});

describe("defaultScanFilters", () => {
  it("returns defaults with DEFAULT_CHAINS when no arg given", () => {
    const filters = defaultScanFilters();
    expect(filters.chains).toEqual([...DEFAULT_CHAINS]);
    expect(filters.limit).toBe(20);
    expect(filters.minLiquidityUsd).toBe(20_000);
    expect(filters.minVolumeH24Usd).toBe(40_000);
    expect(filters.minTxnsH1).toBe(30);
    expect(filters.minPriceChangeH1).toBe(-5);
  });

  it("uses provided chains", () => {
    const filters = defaultScanFilters(["base", "solana"]);
    expect(filters.chains).toEqual(["base", "solana"]);
  });
});
