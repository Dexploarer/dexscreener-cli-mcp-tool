import {
  API_BASE,
  CACHE_TTL_SECONDS,
  MAX_RETRIES,
  RATE_LIMITS_RPM,
  REQUEST_TIMEOUT_SECONDS,
  RETRY_BACKOFF_SECONDS,
} from "./config.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_\-]+$/;

function validatePathSegment(value: string, name: string): string {
  if (!value || !SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${name}: must be alphanumeric (got ${JSON.stringify(value)})`);
  }
  return value;
}

type Bucket = "slow" | "fast";

interface CacheEntry<T = unknown> {
  expiresAt: number;
  payload: T;
}

interface Stats {
  requestsTotal: number;
  cacheHits: number;
  retries: number;
  throttled429: number;
  errors: number;
  statusCounts: Record<string, number>;
  bucketWaitSeconds: Record<Bucket, number>;
  bucketPenaltySeconds: Record<Bucket, number>;
}

export class SlidingWindowLimiter {
  private readonly windowSeconds = 60;
  private readonly maxCalls: number;
  private readonly calls: number[] = [];
  private pending: Promise<void> | null = null;

  constructor(rpm: number) {
    this.maxCalls = rpm;
  }

  async acquire(): Promise<void> {
    // Serialize access so only one caller checks/mutates at a time.
    while (this.pending) {
      await this.pending;
    }

    let resolve: () => void;
    this.pending = new Promise<void>(r => {
      resolve = r;
    });

    try {
      while (true) {
        const now = performance.now() / 1000;
        while (this.calls.length > 0 && now - this.calls[0] >= this.windowSeconds) {
          this.calls.shift();
        }
        if (this.calls.length < this.maxCalls) {
          this.calls.push(now);
          return;
        }
        const waitFor = this.windowSeconds - (now - this.calls[0]);
        // Release the lock while sleeping so other callers can queue.
        this.pending = null;
        resolve!();
        await sleep(Math.max(waitFor * 1000, 50));
        // Re-acquire serialization.
        while (this.pending) {
          await this.pending;
        }
        this.pending = new Promise<void>(r => {
          resolve = r;
        });
      }
    } finally {
      this.pending = null;
      resolve!();
    }
  }
}

export class DexplorerClient {
  private readonly cacheTtl: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly limiters: Record<Bucket, SlidingWindowLimiter>;
  private readonly bucketPauseUntil: Record<Bucket, number> = { slow: 0, fast: 0 };
  private readonly bucketPenaltySeconds: Record<Bucket, number> = { slow: 0, fast: 0 };
  private readonly stats: Stats = {
    requestsTotal: 0,
    cacheHits: 0,
    retries: 0,
    throttled429: 0,
    errors: 0,
    statusCounts: {},
    bucketWaitSeconds: { slow: 0, fast: 0 },
    bucketPenaltySeconds: { slow: 0, fast: 0 },
  };

  constructor(cacheTtlSeconds: number = CACHE_TTL_SECONDS) {
    this.cacheTtl = cacheTtlSeconds;
    this.limiters = {
      slow: new SlidingWindowLimiter(RATE_LIMITS_RPM.slow),
      fast: new SlidingWindowLimiter(RATE_LIMITS_RPM.fast),
    };
  }

  // ── Cache helpers ──────────────────────────────────────────────

  private cacheGet(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (performance.now() / 1000 >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.payload;
  }

  private cacheSet(key: string, payload: unknown): void {
    this.cache.set(key, {
      expiresAt: performance.now() / 1000 + this.cacheTtl,
      payload,
    });
  }

  // ── Stats helpers ──────────────────────────────────────────────

  private bumpStat(key: "requestsTotal" | "cacheHits" | "retries" | "throttled429" | "errors", value = 1): void {
    this.stats[key] += value;
  }

  private bumpStatus(statusCode: number): void {
    const sk = String(statusCode);
    this.stats.statusCounts[sk] = (this.stats.statusCounts[sk] ?? 0) + 1;
  }

  private addBucketWait(bucket: Bucket, seconds: number): void {
    this.stats.bucketWaitSeconds[bucket] += Math.max(seconds, 0);
  }

  // ── Bucket pause / penalty ────────────────────────────────────

  private recordBucketCooldown(bucket: Bucket, retryAfter: number | null): void {
    const basePenalty = this.bucketPenaltySeconds[bucket];
    let nextPenalty = Math.max(basePenalty * 2, 1.5);
    nextPenalty = Math.min(nextPenalty, 30);
    this.bucketPenaltySeconds[bucket] = nextPenalty;
    let cooldown = Math.max(retryAfter ?? 0, nextPenalty);
    cooldown += Math.random() * 0.3 + 0.05; // jitter 0.05–0.35
    const now = performance.now() / 1000;
    this.bucketPauseUntil[bucket] = Math.max(this.bucketPauseUntil[bucket], now + cooldown);
  }

  private decayBucketPenalty(bucket: Bucket): void {
    this.bucketPenaltySeconds[bucket] = Math.max(this.bucketPenaltySeconds[bucket] * 0.65, 0);
  }

  private retryAfterSeconds(headers: Headers): number | null {
    const value = headers.get("retry-after");
    if (!value) return null;
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return null;
    return Math.max(parsed, 0);
  }

  // ── Core fetch with caching, rate limiting, retry ─────────────

  private async getJson(path: string, bucket: Bucket): Promise<unknown> {
    const cached = this.cacheGet(path);
    if (cached !== null) {
      this.bumpStat("cacheHits");
      return cached;
    }

    const limiter = this.limiters[bucket];
    let attempt = 0;

    while (true) {
      // Respect bucket pause (adaptive backoff after 429s).
      const now = performance.now() / 1000;
      const pauseUntil = this.bucketPauseUntil[bucket];
      if (now < pauseUntil) {
        const waitFor = pauseUntil - now;
        this.addBucketWait(bucket, waitFor);
        await sleep(waitFor * 1000);
      }

      await limiter.acquire();
      this.bumpStat("requestsTotal");

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SECONDS * 1000);

      let response: Response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        this.bumpStat("errors");
        throw err;
      }
      clearTimeout(timeoutId);

      this.bumpStatus(response.status);

      if (response.status === 429) {
        this.bumpStat("throttled429");
        const retryAfter = this.retryAfterSeconds(response.headers);
        this.recordBucketCooldown(bucket, retryAfter);
      }

      if (
        (response.status === 429 || response.status === 500 || response.status === 502 ||
         response.status === 503 || response.status === 504) &&
        attempt < MAX_RETRIES
      ) {
        this.bumpStat("retries");
        const sleepFor = RETRY_BACKOFF_SECONDS * (2 ** attempt) + (Math.random() * 0.18 + 0.02);
        await sleep(sleepFor * 1000);
        attempt += 1;
        continue;
      }

      if (response.status >= 400) {
        this.bumpStat("errors");
        const body = await response.text();
        throw new Error(`HTTP ${response.status} for ${path}: ${body}`);
      }

      // Decay bucket penalty after healthy responses.
      this.decayBucketPenalty(bucket);

      const payload: unknown = await response.json();
      this.cacheSet(path, payload);
      return payload;
    }
  }

  // ── Public API methods ────────────────────────────────────────

  async getTokenProfilesLatest(): Promise<Record<string, unknown>[]> {
    const data = await this.getJson("/token-profiles/latest/v1", "slow");
    return data as Record<string, unknown>[];
  }

  async getCommunityTakeoversLatest(): Promise<Record<string, unknown>[]> {
    const data = await this.getJson("/community-takeovers/latest/v1", "slow");
    return data as Record<string, unknown>[];
  }

  async getTokenBoostsLatest(): Promise<Record<string, unknown>[]> {
    const data = await this.getJson("/token-boosts/latest/v1", "slow");
    return data as Record<string, unknown>[];
  }

  async getTokenBoostsTop(): Promise<Record<string, unknown>[]> {
    const data = await this.getJson("/token-boosts/top/v1", "slow");
    return data as Record<string, unknown>[];
  }

  async getOrders(chainId: string, tokenAddress: string): Promise<Record<string, unknown>> {
    validatePathSegment(chainId, "chainId");
    validatePathSegment(tokenAddress, "tokenAddress");
    const data = await this.getJson(`/orders/v1/${chainId}/${tokenAddress}`, "slow");
    return data as Record<string, unknown>;
  }

  async searchPairs(query: string): Promise<Record<string, unknown>[]> {
    const data = await this.getJson(
      `/latest/dex/search?q=${encodeURIComponent(query)}`,
      "fast",
    );
    const obj = data as Record<string, unknown>;
    return (obj.pairs ?? []) as Record<string, unknown>[];
  }

  async getPair(chainId: string, pairAddress: string): Promise<Record<string, unknown>> {
    validatePathSegment(chainId, "chainId");
    validatePathSegment(pairAddress, "pairAddress");
    const data = await this.getJson(
      `/latest/dex/pairs/${chainId}/${pairAddress}`,
      "fast",
    ) as Record<string, unknown>;
    if (data.pair) return data.pair as Record<string, unknown>;
    const pairs = data.pairs as Record<string, unknown>[] | undefined;
    if (pairs && pairs.length > 0) return pairs[0];
    return {};
  }

  async getTokenPairs(chainId: string, tokenAddress: string): Promise<Record<string, unknown>[]> {
    validatePathSegment(chainId, "chainId");
    validatePathSegment(tokenAddress, "tokenAddress");
    const data = await this.getJson(
      `/token-pairs/v1/${chainId}/${tokenAddress}`,
      "fast",
    );
    return data as Record<string, unknown>[];
  }

  async getPairsForTokens(
    chainId: string,
    tokenAddresses: string[],
  ): Promise<Record<string, unknown>[]> {
    validatePathSegment(chainId, "chainId");
    const unique = [...new Set(
      tokenAddresses.map(t => t.trim()).filter(Boolean),
    )];
    for (const addr of unique) {
      validatePathSegment(addr, "tokenAddress");
    }
    const chunks = DexplorerClient.chunked(unique, 30);
    const merged: Record<string, unknown>[] = [];
    for (const chunk of chunks) {
      const path = `/tokens/v1/${chainId}/${chunk.join(",")}`;
      const rows = await this.getJson(path, "fast");
      if (Array.isArray(rows)) {
        merged.push(...(rows as Record<string, unknown>[]));
      }
    }
    return merged;
  }

  async getRuntimeStats(): Promise<Stats> {
    return {
      requestsTotal: this.stats.requestsTotal,
      cacheHits: this.stats.cacheHits,
      retries: this.stats.retries,
      throttled429: this.stats.throttled429,
      errors: this.stats.errors,
      statusCounts: { ...this.stats.statusCounts },
      bucketWaitSeconds: { ...this.stats.bucketWaitSeconds },
      bucketPenaltySeconds: { ...this.bucketPenaltySeconds },
    };
  }

  /** No-op for fetch-based client; keeps the interface consistent. */
  async close(): Promise<void> {
    // Nothing to clean up with native fetch.
  }

  // ── Static helpers ────────────────────────────────────────────

  static chunked<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
      chunks.push(values.slice(i, i + size));
    }
    return chunks;
  }
}
