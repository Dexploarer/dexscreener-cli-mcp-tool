import { describe, it, expect } from "vitest";
import { SlidingWindowLimiter, DexplorerClient } from "./client.js";

describe("DexplorerClient.chunked", () => {
  it("splits array into chunks of given size", () => {
    const result = DexplorerClient.chunked([1, 2, 3, 4, 5], 2);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns single chunk when array is smaller than size", () => {
    const result = DexplorerClient.chunked([1, 2], 5);
    expect(result).toEqual([[1, 2]]);
  });

  it("returns empty array for empty input", () => {
    const result = DexplorerClient.chunked([], 3);
    expect(result).toEqual([]);
  });

  it("handles exact multiples", () => {
    const result = DexplorerClient.chunked([1, 2, 3, 4], 2);
    expect(result).toEqual([[1, 2], [3, 4]]);
  });
});

describe("SlidingWindowLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = new SlidingWindowLimiter(100);
    // Should resolve without delay
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
  });

  it("allows burst up to max calls", async () => {
    const limiter = new SlidingWindowLimiter(5);
    const start = performance.now();

    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }

    const elapsed = performance.now() - start;
    // All 5 should complete nearly instantly (well under 1s)
    expect(elapsed).toBeLessThan(1000);
  });
});
