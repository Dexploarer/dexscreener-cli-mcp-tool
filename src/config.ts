export const API_BASE = "https://api.dexscreener.com";
export const DEFAULT_CHAINS = ["solana", "base", "ethereum", "bsc"] as const;
export const RATE_LIMITS_RPM = { slow: 60, fast: 300 } as const;

function cacheTtlSeconds(): number {
  const raw = process.env.DS_CACHE_TTL_SECONDS?.trim();
  if (!raw) return 10;
  const value = parseInt(raw, 10);
  if (isNaN(value)) return 10;
  return Math.max(1, value);
}

export const CACHE_TTL_SECONDS = cacheTtlSeconds();
export const REQUEST_TIMEOUT_SECONDS = 15;
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_SECONDS = 0.5;

export interface ScanFilters {
  chains: string[];
  limit: number;
  minLiquidityUsd: number;
  minVolumeH24Usd: number;
  minTxnsH1: number;
  minPriceChangeH1: number;
}

export function defaultScanFilters(chains?: string[]): ScanFilters {
  return {
    chains: chains ?? [...DEFAULT_CHAINS],
    limit: 20,
    minLiquidityUsd: 20_000,
    minVolumeH24Usd: 40_000,
    minTxnsH1: 30,
    minPriceChangeH1: -5,
  };
}
