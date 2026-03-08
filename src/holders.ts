import { SlidingWindowLimiter } from "./client.js";
import type { PairSnapshot } from "./models.js";
import { txnsH1 } from "./models.js";

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

const GECKO_CHAIN_IDS: Record<string, string> = {
  solana: "solana",
  ethereum: "eth",
  base: "base",
  bsc: "bsc",
  polygon: "polygon_pos",
  arbitrum: "arbitrum",
  optimism: "optimism",
  avalanche: "avax",
};

const BLOCKSCOUT_URLS: Record<string, string> = {
  ethereum: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
};

const HONEYPOT_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  avalanche: 43114,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  linea: 59144,
  blast: 81457,
  zksync: 324,
  mantle: 5000,
};

const MORALIS_EVM_CHAINS: Record<string, string> = {
  ethereum: "eth",
  bsc: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  base: "base",
  optimism: "optimism",
  avalanche: "avalanche",
};

const moralisApiKey: string = process.env.MORALIS_API_KEY?.trim() ?? "";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const HOLDER_CACHE_TTL_SECONDS = 15 * 60;
const HOLDER_REQUEST_TIMEOUT_SECONDS = 8000; // ms for AbortController
const HOLDER_REQUESTS_PER_MINUTE = 28;

const holderLimiter = new SlidingWindowLimiter(HOLDER_REQUESTS_PER_MINUTE);

interface CacheEntry {
  expiresAt: number;
  holdersCount: number | null;
  holdersSource: string | null;
}

const holderCache = new Map<string, CacheEntry>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cacheKey(chainId: string, tokenAddress: string): string {
  return `${chainId.trim().toLowerCase()}:${tokenAddress.trim().toLowerCase()}`;
}

function cacheGet(
  chainId: string,
  tokenAddress: string
): { holdersCount: number | null; holdersSource: string | null } | null {
  const key = cacheKey(chainId, tokenAddress);
  const item = holderCache.get(key);
  if (!item) return null;
  if (Date.now() >= item.expiresAt) {
    holderCache.delete(key);
    return null;
  }
  return { holdersCount: item.holdersCount, holdersSource: item.holdersSource };
}

function cacheSet(
  chainId: string,
  tokenAddress: string,
  holdersCount: number | null,
  holdersSource: string | null
): void {
  const key = cacheKey(chainId, tokenAddress);
  holderCache.set(key, {
    expiresAt: Date.now() + HOLDER_CACHE_TTL_SECONDS * 1000,
    holdersCount,
    holdersSource,
  });
}

// ---------------------------------------------------------------------------
// Provider: GeckoTerminal (all chains, free, no key)
// ---------------------------------------------------------------------------

async function fetchGecko(
  chainId: string,
  tokenAddress: string
): Promise<number | null> {
  const network = GECKO_CHAIN_IDS[chainId];
  if (!network) return null;

  const safeToken = encodeURIComponent(tokenAddress);
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${safeToken}/info`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        HOLDER_REQUEST_TIMEOUT_SECONDS
      );
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (resp.status >= 400) return null;

      const data = await resp.json();
      const attrs = data?.data?.attributes ?? {};
      const holders = attrs.holders;
      if (holders != null && typeof holders === "object") {
        const count = holders.count;
        if (count != null) return Math.trunc(Number(count));
      }
      return null;
    } catch {
      if (attempt < 2) {
        await sleep(1000);
        continue;
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider: Blockscout (ETH + Base, free, no key)
// ---------------------------------------------------------------------------

async function fetchBlockscout(
  chainId: string,
  tokenAddress: string
): Promise<number | null> {
  const baseUrl = BLOCKSCOUT_URLS[chainId];
  if (!baseUrl) return null;

  try {
    const safeToken = encodeURIComponent(tokenAddress);
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HOLDER_REQUEST_TIMEOUT_SECONDS
    );
    const resp = await fetch(`${baseUrl}/api/v2/tokens/${safeToken}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (resp.status >= 400) return null;

    const data = await resp.json();
    const raw = data.holders_count ?? data.holders;
    if (raw != null) return Math.trunc(Number(raw));
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider: Honeypot.is (EVM only, no key)
// ---------------------------------------------------------------------------

function parseHoneypotHolders(
  payload: Record<string, any>
): number | null {
  const token = payload.token;
  if (token != null && typeof token === "object") {
    const raw = token.totalHolders;
    if (raw == null) return null;
    try {
      return Math.trunc(Number(raw));
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchHoneypot(
  chainId: string,
  tokenAddress: string
): Promise<number | null> {
  const chainNumeric = HONEYPOT_CHAIN_IDS[chainId];
  if (chainNumeric == null) return null;

  try {
    const params = new URLSearchParams({
      address: tokenAddress,
      chainID: String(chainNumeric),
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HOLDER_REQUEST_TIMEOUT_SECONDS
    );
    const resp = await fetch(
      `https://api.honeypot.is/v2/IsHoneypot?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (resp.status >= 400) return null;

    const payload = await resp.json();
    return parseHoneypotHolders(
      payload != null && typeof payload === "object" ? payload : {}
    );
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider: Moralis (EVM + Solana, requires API key)
// ---------------------------------------------------------------------------

async function fetchMoralis(
  chainId: string,
  tokenAddress: string
): Promise<number | null> {
  if (!moralisApiKey) return null;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-API-Key": moralisApiKey,
  };

  let url: string;
  const safeToken = encodeURIComponent(tokenAddress);

  if (chainId === "solana") {
    url = `https://solana-gateway.moralis.io/token/mainnet/${safeToken}/holders`;
  } else if (chainId in MORALIS_EVM_CHAINS) {
    const moralisChain = MORALIS_EVM_CHAINS[chainId];
    const params = new URLSearchParams({ chain: moralisChain });
    url = `https://deep-index.moralis.io/api/v2.2/erc20/${safeToken}/holders?${params.toString()}`;
  } else {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HOLDER_REQUEST_TIMEOUT_SECONDS
    );
    const resp = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (resp.status >= 400) return null;

    const data = await resp.json();
    const raw = data.totalHolders;
    if (raw != null) return Math.trunc(Number(raw));
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main fetch: tries providers in order
// ---------------------------------------------------------------------------

export async function fetchHolderCount(
  chainId: string,
  tokenAddress: string
): Promise<{ count: number | null; source: string | null }> {
  const normalizedChain = chainId.trim().toLowerCase();
  const normalizedToken = tokenAddress.trim();
  if (!normalizedToken) return { count: null, source: null };

  const cached = cacheGet(normalizedChain, normalizedToken);
  if (cached != null) {
    return { count: cached.holdersCount, source: cached.holdersSource };
  }

  try {
    await holderLimiter.acquire();

    // 1. GeckoTerminal (free, no key, all chains)
    if (normalizedChain in GECKO_CHAIN_IDS) {
      const count = await fetchGecko(normalizedChain, normalizedToken);
      if (count != null && count > 0) {
        cacheSet(normalizedChain, normalizedToken, count, "geckoterminal");
        return { count, source: "geckoterminal" };
      }
    }

    // 2. Moralis (EVM + Solana, requires API key)
    if (
      moralisApiKey &&
      (normalizedChain in MORALIS_EVM_CHAINS || normalizedChain === "solana")
    ) {
      const count = await fetchMoralis(normalizedChain, normalizedToken);
      if (count != null && count > 0) {
        cacheSet(normalizedChain, normalizedToken, count, "moralis");
        return { count, source: "moralis" };
      }
    }

    // 3. Blockscout (ETH + Base, free, no key)
    if (normalizedChain in BLOCKSCOUT_URLS) {
      const count = await fetchBlockscout(normalizedChain, normalizedToken);
      if (count != null && count > 0) {
        cacheSet(normalizedChain, normalizedToken, count, "blockscout");
        return { count, source: "blockscout" };
      }
    }

    // 4. Honeypot.is (EVM only, no key)
    if (normalizedChain in HONEYPOT_CHAIN_IDS) {
      const count = await fetchHoneypot(normalizedChain, normalizedToken);
      if (count != null && count > 0) {
        cacheSet(normalizedChain, normalizedToken, count, "honeypot.is");
        return { count, source: "honeypot.is" };
      }
    }

    // No provider returned data
    cacheSet(normalizedChain, normalizedToken, null, null);
    return { count: null, source: null };
  } catch {
    cacheSet(normalizedChain, normalizedToken, null, "error");
    return { count: null, source: "error" };
  }
}

// ---------------------------------------------------------------------------
// Hydrate helpers
// ---------------------------------------------------------------------------

export async function hydratePairHolders(
  pairs: PairSnapshot[],
  maxPairs?: number
): Promise<void> {
  if (pairs.length === 0) return;

  // Group by (chain, lowercaseToken) for dedup, preserve original-case address
  const grouped = new Map<
    string,
    { chain: string; originalToken: string; pairs: PairSnapshot[] }
  >();

  for (const pair of pairs) {
    if (pair.holdersCount != null) continue;
    const token = pair.baseAddress.trim();
    const chain = pair.chainId.trim().toLowerCase();
    if (!token) continue;
    const key = `${chain}:${token.toLowerCase()}`;
    if (!grouped.has(key)) {
      grouped.set(key, { chain, originalToken: token, pairs: [] });
    }
    grouped.get(key)!.pairs.push(pair);
  }

  if (grouped.size === 0) return;

  // Sort by priority score descending
  const ordered = [...grouped.entries()].sort((a, b) => {
    const scoreA = Math.max(
      ...a[1].pairs.map(
        (p) =>
          p.volumeH1 +
          p.volumeH24 * 0.1 +
          p.liquidityUsd * 0.01 +
          txnsH1(p) * 10
      )
    );
    const scoreB = Math.max(
      ...b[1].pairs.map(
        (p) =>
          p.volumeH1 +
          p.volumeH24 * 0.1 +
          p.liquidityUsd * 0.01 +
          txnsH1(p) * 10
      )
    );
    return scoreB - scoreA;
  });

  const limited =
    maxPairs != null && maxPairs > 0 ? ordered.slice(0, maxPairs) : ordered;

  // Concurrency limiter (semaphore of 3)
  let running = 0;
  const queue: Array<() => void> = [];

  async function acquireSemaphore(): Promise<void> {
    if (running < 3) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => {
      queue.push(resolve);
    });
    running++;
  }

  function releaseSemaphore(): void {
    running--;
    const next = queue.shift();
    if (next) next();
  }

  const workers = limited.map(
    async ([, { chain, originalToken, pairs: bucket }]) => {
      await acquireSemaphore();
      try {
        const { count, source } = await fetchHolderCount(chain, originalToken);
        for (const pair of bucket) {
          pair.holdersCount = count;
          pair.holdersSource = source;
        }
      } finally {
        releaseSemaphore();
      }
    }
  );

  await Promise.all(workers);
}
