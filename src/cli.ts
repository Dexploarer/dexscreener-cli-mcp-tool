#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { DEFAULT_CHAINS, type ScanFilters, defaultScanFilters } from "./config.js";
import { DexplorerClient } from "./client.js";
import { HotScanner } from "./scanner.js";
import {
  type HotTokenCandidate,
  type PairSnapshot,
  txnsH1,
  txnsH24,
  ageHours,
  pairKey,
} from "./models.js";
import { scoreHotnessDetail, buildDistributionHeuristics } from "./scoring.js";
import {
  StateStore,
  type ScanPreset,
  type ScanTask,
  utcNowIso,
  scanPresetFromFilters,
  scanPresetToFilters,
  scanPresetToDict,
  scanTaskCreate,
  scanTaskToDict,
} from "./state.js";
import { hydratePairHolders } from "./holders.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_PROFILE_BASELINES: Record<string, Record<string, number>> = {
  strict:    { min_liq: 35_000, min_vol: 90_000, min_txns: 50 },
  balanced:  { min_liq: 20_000, min_vol: 40_000, min_txns: 25 },
  discovery: { min_liq:  8_000, min_vol: 10_000, min_txns:  5 },
};

const CHAIN_PROFILE_MULTIPLIER: Record<string, number> = {
  solana: 1.0,
  base: 0.9,
  bsc: 0.85,
  arbitrum: 0.95,
  ethereum: 1.15,
};

const AI_SEARCH_QUERIES = [
  "virtual", "aixbt", "agent", "ai", "gpt", "llm", "bot", "neural", "inference",
];

const AI_KEYWORDS = [
  "ai", "agent", "gpt", "llm", "neural", "model", "intelligence", "bot",
  "oracle", "assistant", "auton", "compute", "inference", "virtual", "aixbt",
];

const NEW_TOKEN_SEARCH_QUERIES = [
  "new", "launch", "launched", "base", "coin", "token", "meme", "pump", "moon",
  "cat", "dog", "pepe", "inu", "ai", "agent", "gpt", "eth", "sol", "alpha",
  "beta", "gem", "degen", "official", "2026", "2025", "x", "z", "a", "e",
  "i", "o", "u",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseChains(raw: string): string[] {
  const values = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? values : [...DEFAULT_CHAINS];
}

function profileMultiplier(chains: string[]): number {
  const factors = chains.map((c) => CHAIN_PROFILE_MULTIPLIER[c] ?? 1.0);
  return factors.length > 0 ? Math.max(...factors) : 1.0;
}

function resolveScanProfile(
  profile: string,
  chains: string[],
): { minLiq: number; minVol: number; minTxns: number } {
  const selected = SCAN_PROFILE_BASELINES[profile] ? profile : "balanced";
  const baseline = SCAN_PROFILE_BASELINES[selected];
  const factor = profileMultiplier(chains);
  return {
    minLiq: baseline.min_liq * factor,
    minVol: baseline.min_vol * factor,
    minTxns: Math.max(1, Math.round(baseline.min_txns * factor)),
  };
}

function resolvedFilters(opts: {
  chains?: string;
  limit?: number;
  minLiquidityUsd?: number;
  minVolumeH24Usd?: number;
  minTxnsH1?: number;
  minPriceChangeH1?: number;
  preset?: string;
}): ScanFilters {
  let resolved = defaultScanFilters();

  const store = new StateStore();
  if (opts.preset) {
    const preset = store.getPreset(opts.preset);
    if (!preset) {
      process.stderr.write(chalk.red(`Preset '${opts.preset}' not found.\n`));
      process.exit(1);
    }
    resolved = scanPresetToFilters(preset);
  } else {
    const def = store.getPreset("default");
    if (def) resolved = scanPresetToFilters(def);
  }

  if (opts.chains) resolved.chains = parseChains(opts.chains);
  if (opts.limit != null) resolved.limit = opts.limit;
  if (opts.minLiquidityUsd != null) resolved.minLiquidityUsd = opts.minLiquidityUsd;
  if (opts.minVolumeH24Usd != null) resolved.minVolumeH24Usd = opts.minVolumeH24Usd;
  if (opts.minTxnsH1 != null) resolved.minTxnsH1 = opts.minTxnsH1;
  if (opts.minPriceChangeH1 != null) resolved.minPriceChangeH1 = opts.minPriceChangeH1;
  return resolved;
}

function candidateJson(c: HotTokenCandidate): Record<string, unknown> {
  const p = c.pair;
  const a = c.analytics;
  return {
    chainId: p.chainId,
    tokenAddress: p.baseAddress,
    tokenSymbol: p.baseSymbol,
    tokenName: p.baseName,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    pairUrl: p.pairUrl,
    priceUsd: p.priceUsd,
    priceChangeH1: p.priceChangeH1,
    priceChangeH24: p.priceChangeH24,
    volumeH24: p.volumeH24,
    txnsH1: txnsH1(p),
    liquidityUsd: p.liquidityUsd,
    marketCap: p.marketCap,
    fdv: p.fdv,
    holdersCount: p.holdersCount,
    holdersSource: p.holdersSource,
    boostTotal: c.boostTotal,
    boostCount: c.boostCount,
    hasProfile: c.hasProfile,
    score: c.score,
    tags: c.tags,
    analytics: {
      volumeToLiquidity: a.volumeToLiquidity,
      buyPressure: a.buyPressure,
      spreadH1H24: a.spreadH1H24,
      momentumM5H1: a.momentumM5H1,
      holderScore: a.holderScore,
      ageScore: a.ageScore,
    },
  };
}

function pairJson(pair: PairSnapshot): Record<string, unknown> {
  return {
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    pairUrl: pair.pairUrl,
    tokenAddress: pair.baseAddress,
    tokenSymbol: pair.baseSymbol,
    tokenName: pair.baseName,
    quoteSymbol: pair.quoteSymbol,
    priceUsd: pair.priceUsd,
    priceChangeH1: pair.priceChangeH1,
    priceChangeH24: pair.priceChangeH24,
    volumeH24: pair.volumeH24,
    volumeH6: pair.volumeH6,
    volumeH1: pair.volumeH1,
    volumeM5: pair.volumeM5,
    buysH1: pair.buysH1,
    sellsH1: pair.sellsH1,
    buysH24: pair.buysH24,
    sellsH24: pair.sellsH24,
    txnsH1: txnsH1(pair),
    txnsH24: txnsH24(pair),
    liquidityUsd: pair.liquidityUsd,
    marketCap: pair.marketCap,
    fdv: pair.fdv,
    holdersCount: pair.holdersCount,
    holdersSource: pair.holdersSource,
    pairCreatedAtMs: pair.pairCreatedAtMs,
    ageHours: ageHours(pair),
  };
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function colorPct(n: number): string {
  const s = fmtPct(n);
  if (n >= 10) return chalk.bold.green(s);
  if (n > 0) return chalk.green(s);
  if (n <= -10) return chalk.bold.red(s);
  if (n < 0) return chalk.red(s);
  return chalk.gray(s);
}

function pad(s: string, width: number, right = false): string {
  if (right) return s.padStart(width);
  return s.padEnd(width);
}

// ---------------------------------------------------------------------------
// Shared scan helper
// ---------------------------------------------------------------------------

async function runScan(filters: ScanFilters): Promise<HotTokenCandidate[]> {
  const client = new DexplorerClient();
  try {
    const scanner = new HotScanner(client);
    return await scanner.scan(filters);
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Renderers (plain text)
// ---------------------------------------------------------------------------

function renderHotTable(
  candidates: HotTokenCandidate[],
  filters: ScanFilters,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.bold.white("=== Dexplorer Hot Tokens ===") +
      chalk.gray(
        `  chains=${filters.chains.join(",")} liq>=${fmtUsd(filters.minLiquidityUsd)} vol>=${fmtUsd(filters.minVolumeH24Usd)} tx1h>=${filters.minTxnsH1}`,
      ),
  );
  lines.push("");

  const header = [
    pad("#", 4, true),
    pad("Chain", 10),
    pad("Token", 10),
    pad("Score", 7, true),
    pad("1h%", 10, true),
    pad("24h Vol", 14, true),
    pad("Liq", 14, true),
    pad("Txns", 7, true),
    pad("Holders", 9, true),
  ].join("  ");
  lines.push(chalk.bold.white(header));
  lines.push(chalk.gray("-".repeat(header.length)));

  if (candidates.length === 0) {
    lines.push(chalk.yellow("  No tokens matched filters."));
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const p = c.pair;
    const t1 = txnsH1(p);
    const holdersStr =
      p.holdersCount != null ? p.holdersCount.toLocaleString() : "-";
    const row = [
      pad(String(i + 1), 4, true),
      pad(p.chainId, 10),
      pad(p.baseSymbol.slice(0, 9), 10),
      pad(c.score.toFixed(1), 7, true),
      pad(fmtPct(p.priceChangeH1), 10, true),
      pad(fmtUsd(p.volumeH24), 14, true),
      pad(fmtUsd(p.liquidityUsd), 14, true),
      pad(String(t1), 7, true),
      pad(holdersStr, 9, true),
    ].join("  ");

    // Color the score portion
    const scoreVal = c.score;
    const scoreColor =
      scoreVal >= 70 ? chalk.bold.green : scoreVal >= 40 ? chalk.yellow : chalk.gray;
    lines.push(
      pad(String(i + 1), 4, true) +
        "  " +
        pad(p.chainId, 10) +
        "  " +
        chalk.bold.yellow(pad(p.baseSymbol.slice(0, 9), 10)) +
        "  " +
        scoreColor(pad(c.score.toFixed(1), 7, true)) +
        "  " +
        pad(colorPct(p.priceChangeH1), 10 + 10, true) + // ANSI codes add length
        "  " +
        pad(fmtUsd(p.volumeH24), 14, true) +
        "  " +
        pad(fmtUsd(p.liquidityUsd), 14, true) +
        "  " +
        pad(String(t1), 7, true) +
        "  " +
        pad(holdersStr, 9, true),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderPairsTable(pairs: PairSnapshot[], title: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold.white(`=== ${title} ===`));
  lines.push("");

  if (pairs.length === 0) {
    lines.push(chalk.yellow("  No results found."));
    lines.push("");
    return lines.join("\n");
  }

  const header = [
    pad("#", 4, true),
    pad("Chain", 10),
    pad("Token", 10),
    pad("1h%", 10, true),
    pad("24h Vol", 14, true),
    pad("Liq", 14, true),
    pad("Txns", 7, true),
    pad("Price", 14, true),
  ].join("  ");
  lines.push(chalk.bold.white(header));
  lines.push(chalk.gray("-".repeat(90)));

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const t1 = txnsH1(p);
    const priceStr =
      p.priceUsd < 0.01
        ? `$${p.priceUsd.toFixed(8)}`
        : `$${p.priceUsd.toFixed(6)}`;
    lines.push(
      pad(String(i + 1), 4, true) +
        "  " +
        pad(p.chainId, 10) +
        "  " +
        chalk.bold.yellow(pad(p.baseSymbol.slice(0, 9), 10)) +
        "  " +
        colorPct(p.priceChangeH1).padStart(20) +
        "  " +
        pad(fmtUsd(p.volumeH24), 14, true) +
        "  " +
        pad(fmtUsd(p.liquidityUsd), 14, true) +
        "  " +
        pad(String(t1), 7, true) +
        "  " +
        pad(priceStr, 14, true),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderInspectView(
  pair: PairSnapshot,
  heuristics?: Record<string, number | string>,
  boostTotal?: number,
  boostCount?: number,
  extraPairs?: number,
): string {
  const lines: string[] = [];
  const age = ageHours(pair);
  const ageStr = age != null ? `${age.toFixed(1)}h` : "unknown";
  const t1 = txnsH1(pair);
  const t24 = txnsH24(pair);
  const holdersStr =
    pair.holdersCount != null ? pair.holdersCount.toLocaleString() : "n/a";

  lines.push("");
  lines.push(chalk.bold.white("=== Token Inspection ==="));
  lines.push("");
  lines.push(`  ${chalk.bold("Token:")}      ${chalk.yellow(pair.baseSymbol)} (${pair.baseName})`);
  lines.push(`  ${chalk.bold("Chain:")}      ${pair.chainId}`);
  lines.push(`  ${chalk.bold("Address:")}    ${pair.baseAddress}`);
  lines.push(`  ${chalk.bold("Pair:")}       ${pair.pairAddress} (${pair.dexId})`);
  lines.push(`  ${chalk.bold("Price:")}      $${pair.priceUsd < 0.01 ? pair.priceUsd.toFixed(8) : pair.priceUsd.toFixed(6)}`);
  lines.push(`  ${chalk.bold("1h Change:")}  ${colorPct(pair.priceChangeH1)}`);
  lines.push(`  ${chalk.bold("24h Change:")} ${colorPct(pair.priceChangeH24)}`);
  lines.push(`  ${chalk.bold("24h Volume:")} ${fmtUsd(pair.volumeH24)}`);
  lines.push(`  ${chalk.bold("Liquidity:")}  ${fmtUsd(pair.liquidityUsd)}`);
  lines.push(`  ${chalk.bold("MCap:")}       ${fmtUsd(pair.marketCap || pair.fdv)}`);
  lines.push(`  ${chalk.bold("Txns 1h:")}    ${t1} (buys: ${pair.buysH1}, sells: ${pair.sellsH1})`);
  lines.push(`  ${chalk.bold("Txns 24h:")}   ${t24} (buys: ${pair.buysH24}, sells: ${pair.sellsH24})`);
  lines.push(`  ${chalk.bold("Holders:")}    ${holdersStr}${pair.holdersSource ? ` (${pair.holdersSource})` : ""}`);
  lines.push(`  ${chalk.bold("Age:")}        ${ageStr}`);
  lines.push(`  ${chalk.bold("URL:")}        ${pair.pairUrl}`);

  if (boostTotal != null) {
    lines.push("");
    lines.push(`  ${chalk.bold("Boost Total:")} ${boostTotal.toFixed(0)}`);
    lines.push(`  ${chalk.bold("Boost Count:")} ${boostCount ?? 0}`);
  }
  if (extraPairs != null && extraPairs > 0) {
    lines.push(`  ${chalk.bold("Other Pairs:")} ${extraPairs}`);
  }

  if (heuristics) {
    lines.push("");
    lines.push(chalk.bold("  Distribution Heuristics:"));
    for (const [key, value] of Object.entries(heuristics)) {
      lines.push(`    ${key}: ${value}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("dexplorer")
  .description(
    "Visual Dexplorer scanner CLI. Spot hot runners and inspect pair flow from the terminal.",
  )
  .version("1.0.0");

// ── hot ──────────────────────────────────────────────────────────────────────

program
  .command("hot")
  .description("One-shot hot runner scan")
  .option("--chains <chains>", "Comma-separated chain IDs")
  .option("--limit <n>", "Number of rows", parseInt)
  .option("--min-liquidity-usd <n>", "Minimum pair liquidity in USD", parseFloat)
  .option("--min-volume-h24-usd <n>", "Minimum 24h volume in USD", parseFloat)
  .option("--min-txns-h1 <n>", "Minimum 1h transactions", parseInt)
  .option("--min-price-change-h1 <n>", "Minimum 1h price change percent", parseFloat)
  .option("--preset <name>", "Named preset to load before overrides")
  .option("--json", "Output machine-readable JSON", false)
  .action(async (opts) => {
    const filters = resolvedFilters({
      chains: opts.chains,
      limit: opts.limit,
      minLiquidityUsd: opts.minLiquidityUsd,
      minVolumeH24Usd: opts.minVolumeH24Usd,
      minTxnsH1: opts.minTxnsH1,
      minPriceChangeH1: opts.minPriceChangeH1,
      preset: opts.preset,
    });
    const candidates = await runScan(filters);
    if (opts.json) {
      console.log(JSON.stringify(candidates.map(candidateJson), null, 2));
      return;
    }
    process.stdout.write(renderHotTable(candidates, filters));
  });

// ── search ───────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search tokens")
  .option("--limit <n>", "Max result rows", parseInt, 20)
  .option("--json", "Output machine-readable JSON", false)
  .action(async (query: string, opts) => {
    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const pairs = await scanner.search(query, opts.limit);
      await hydratePairHolders(pairs, opts.limit);
      if (opts.json) {
        console.log(JSON.stringify(pairs.map(pairJson), null, 2));
        return;
      }
      process.stdout.write(renderPairsTable(pairs, `Search: ${query}`));
    } finally {
      await client.close();
    }
  });

// ── inspect ──────────────────────────────────────────────────────────────────

program
  .command("inspect <chain> <token>")
  .description("Deep-dive token inspection")
  .option("--json", "Output machine-readable JSON", false)
  .action(async (chain: string, token: string, opts) => {
    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const pairs = await scanner.inspectToken(chain, token);
      if (pairs.length === 0) {
        process.stderr.write(chalk.red("Token not found or no pairs available.\n"));
        process.exit(1);
      }

      const primary = pairs[0];
      const orders = await client.getOrders(chain, token);
      const boosts: any[] = (orders as any).boosts ?? [];
      const boostTotal = boosts.reduce(
        (sum: number, b: any) => sum + (parseFloat(b.amount) || 0),
        0,
      );
      const boostCount = boosts.length;
      const hasProfile = ((orders as any).orders ?? []).some(
        (o: any) => o.type === "tokenProfile",
      );

      // Build a minimal candidate for heuristics
      const candidate: HotTokenCandidate = {
        pair: primary,
        score: 0,
        boostTotal,
        boostCount,
        hasProfile,
        discovery: "inspect",
        tags: [],
        analytics: {
          volumeToLiquidity: 0,
          buyPressure: 0,
          spreadH1H24: 0,
          momentumM5H1: 0,
          holderScore: 0,
          ageScore: 0,
        },
      };
      const heuristics = buildDistributionHeuristics(candidate);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              primaryPair: pairJson(primary),
              distributionProxy: heuristics,
              boostTotal,
              boostCount,
              hasProfile,
              additionalPairCount: Math.max(pairs.length - 1, 0),
            },
            null,
            2,
          ),
        );
        return;
      }
      process.stdout.write(
        renderInspectView(primary, heuristics, boostTotal, boostCount, pairs.length - 1),
      );
    } finally {
      await client.close();
    }
  });

// ── watch ────────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Live dashboard (re-runs scan in a loop, clears screen each time)")
  .option("--chains <chains>", "Comma-separated chain IDs")
  .option("--limit <n>", "Number of rows", parseInt)
  .option("--interval <seconds>", "Refresh interval in seconds", parseFloat, 7)
  .option("--json", "Output machine-readable JSON", false)
  .action(async (opts) => {
    const filters = resolvedFilters({
      chains: opts.chains,
      limit: opts.limit ?? 16,
    });
    const interval = opts.interval ?? 7;
    const client = new DexplorerClient();
    const scanner = new HotScanner(client);

    const runLoop = async () => {
      try {
        const candidates = await scanner.scan(filters);
        if (opts.json) {
          console.clear();
          console.log(JSON.stringify(candidates.map(candidateJson), null, 2));
        } else {
          console.clear();
          process.stdout.write(renderHotTable(candidates, filters));
          process.stdout.write(
            chalk.gray(`  Refreshing every ${interval}s | Ctrl+C to exit\n`),
          );
        }
      } catch (err: any) {
        process.stderr.write(chalk.red(`Scan error: ${err.message}\n`));
      }
    };

    await runLoop();
    const timer = setInterval(runLoop, interval * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      client.close().finally(() => process.exit(0));
    });
    await new Promise(() => {}); // hang forever
  });

// ── alpha-drops ──────────────────────────────────────────────────────────────

program
  .command("alpha-drops")
  .description("One-shot alpha drop scan with quality gates")
  .option("--chains <chains>", "Comma-separated chain IDs", "base,solana")
  .option("--limit <n>", "Max rows", parseInt, 15)
  .option("--max-age-hours <n>", "Only include pairs newer than this age", parseFloat, 6)
  .option("--profile <name>", "Filter profile: strict/balanced/discovery", "balanced")
  .option("--sort-by <mode>", "Sort mode: score/readiness/volume/momentum", "readiness")
  .option("--min-breakout-readiness <n>", "Minimum breakout readiness (0-100)", parseFloat, 55)
  .option("--min-relative-strength <n>", "Minimum relative strength", parseFloat, 0)
  .option("--decay-filter", "Filter fast-decay momentum profiles", true)
  .option("--max-vol-liq-ratio <n>", "Maximum 24h volume/liquidity ratio", parseFloat, 60)
  .option("--json", "Output machine-readable JSON", false)
  .action(async (opts) => {
    const chains = parseChains(opts.chains);
    const resolved = resolveScanProfile(opts.profile, chains);
    const fetchLimit = Math.min(Math.max(opts.limit * 6, 60), 150);

    const filters: ScanFilters = {
      chains,
      limit: fetchLimit,
      minLiquidityUsd: resolved.minLiq,
      minVolumeH24Usd: resolved.minVol,
      minTxnsH1: resolved.minTxns,
      minPriceChangeH1: 0,
    };

    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const raw = await scanner.scan(filters);

      // Filter for new tokens by age and quality gates
      const fresh = raw.filter((c) => {
        const age = ageHours(c.pair);
        if (age == null) return false;
        if (age > opts.maxAgeHours) return false;
        // Vol/liq ratio check
        const volLiqRatio =
          c.pair.volumeH24 / Math.max(c.pair.liquidityUsd, 1);
        if (opts.maxVolLiqRatio > 0 && volLiqRatio > opts.maxVolLiqRatio)
          return false;
        return true;
      });

      // Sort
      fresh.sort((a, b) => b.score - a.score);
      const top = fresh.slice(0, opts.limit);

      if (opts.json) {
        console.log(JSON.stringify(top.map(candidateJson), null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push("");
      lines.push(
        chalk.bold.white("=== Alpha Drops ===") +
          chalk.gray(
            `  chains=${chains.join(",")} age<${opts.maxAgeHours}h limit=${opts.limit}`,
          ),
      );
      lines.push("");

      const header = [
        pad("#", 4, true),
        pad("Chain", 10),
        pad("Token", 10),
        pad("Score", 7, true),
        pad("Age", 7, true),
        pad("1h%", 10, true),
        pad("24h Vol", 14, true),
        pad("Liq", 14, true),
        pad("Txns", 7, true),
      ].join("  ");
      lines.push(chalk.bold.white(header));
      lines.push(chalk.gray("-".repeat(90)));

      if (top.length === 0) {
        lines.push(chalk.yellow("  No alpha drops matched current gates."));
      }

      for (let i = 0; i < top.length; i++) {
        const c = top[i];
        const p = c.pair;
        const age = ageHours(p);
        const ageStr = age != null ? `${age.toFixed(1)}h` : "?";
        const t1 = txnsH1(p);
        lines.push(
          pad(String(i + 1), 4, true) +
            "  " +
            pad(p.chainId, 10) +
            "  " +
            chalk.bold.yellow(pad(p.baseSymbol.slice(0, 9), 10)) +
            "  " +
            pad(c.score.toFixed(1), 7, true) +
            "  " +
            chalk.cyan(pad(ageStr, 7, true)) +
            "  " +
            colorPct(p.priceChangeH1).padStart(20) +
            "  " +
            pad(fmtUsd(p.volumeH24), 14, true) +
            "  " +
            pad(fmtUsd(p.liquidityUsd), 14, true) +
            "  " +
            pad(String(t1), 7, true),
        );
      }

      lines.push("");
      if (top.length < opts.limit) {
        lines.push(
          chalk.yellow(
            `  Only found ${top.length} alpha drops. Lower filters to widen coverage.`,
          ),
        );
        lines.push("");
      }
      process.stdout.write(lines.join("\n"));
    } finally {
      await client.close();
    }
  });

// ── ai-top ───────────────────────────────────────────────────────────────────

program
  .command("ai-top")
  .description("AI-themed tokens")
  .option("--chain <chain>", "Chain ID", "base")
  .option("--limit <n>", "Max rows to show", parseInt, 10)
  .option("--json", "Output machine-readable JSON", false)
  .action(async (opts) => {
    const chain = opts.chain.toLowerCase().trim();
    const client = new DexplorerClient();
    try {
      // Search across AI queries
      const allPairs: Record<string, unknown>[] = [];
      for (const query of AI_SEARCH_QUERIES) {
        try {
          const rows = await client.searchPairs(query);
          allPairs.push(...rows);
        } catch {
          // skip failed queries
        }
      }

      // Filter for chain and AI keywords
      const filtered = allPairs.filter((p: any) => {
        if (String(p.chainId ?? "").toLowerCase() !== chain) return false;
        const base = p.baseToken ?? {};
        const symbol = String(base.symbol ?? "");
        const name = String(base.name ?? "");
        const labels = (p.labels ?? []).join(" ");
        const hay = `${symbol} ${name} ${labels}`.toLowerCase();
        return AI_KEYWORDS.some((kw) => hay.includes(kw));
      });

      // Dedup by token address, keep highest volume
      const dedup = new Map<string, any>();
      for (const p of filtered) {
        const addr = String((p as any).baseToken?.address ?? "");
        if (!addr) continue;
        const vol = parseFloat(((p as any).volume?.h24 ?? 0) as string) || 0;
        const prev = dedup.get(addr);
        if (!prev || vol > (parseFloat((prev.volume?.h24 ?? 0) as string) || 0)) {
          dedup.set(addr, p);
        }
      }

      // Build rows
      const rows: Record<string, unknown>[] = [];
      for (const p of Array.from(dedup.values())) {
        const base = (p as any).baseToken ?? {};
        const txH1 = (p as any).txns?.h1 ?? {};
        const buys = parseInt(txH1.buys ?? "0", 10) || 0;
        const sells = parseInt(txH1.sells ?? "0", 10) || 0;
        const t1 = buys + sells;
        const vol24 = parseFloat(((p as any).volume?.h24 ?? 0) as string) || 0;
        const liq = parseFloat(((p as any).liquidity?.usd ?? 0) as string) || 0;

        rows.push({
          chainId: chain,
          symbol: String(base.symbol ?? "?"),
          name: String(base.name ?? "?"),
          tokenAddress: String(base.address ?? ""),
          priceUsd: parseFloat((p as any).priceUsd ?? "0") || 0,
          priceChangeH1: parseFloat(((p as any).priceChange?.h1 ?? 0) as string) || 0,
          priceChangeH24: parseFloat(((p as any).priceChange?.h24 ?? 0) as string) || 0,
          volumeH24: vol24,
          liquidityUsd: liq,
          txnsH1: t1,
          pairUrl: String((p as any).url ?? ""),
        });
      }

      rows.sort((a, b) => (b.volumeH24 as number) - (a.volumeH24 as number));
      const top = rows.slice(0, opts.limit);

      if (opts.json) {
        console.log(JSON.stringify(top, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push("");
      lines.push(
        chalk.bold.white("=== Top AI Tokens ===") +
          chalk.gray(`  chain=${chain} limit=${opts.limit}`),
      );
      lines.push("");

      const header = [
        pad("#", 4, true),
        pad("Token", 10),
        pad("1h%", 10, true),
        pad("24h Vol", 14, true),
        pad("Txns", 7, true),
        pad("Liq", 14, true),
      ].join("  ");
      lines.push(chalk.bold.white(header));
      lines.push(chalk.gray("-".repeat(70)));

      for (let i = 0; i < top.length; i++) {
        const r = top[i];
        lines.push(
          pad(String(i + 1), 4, true) +
            "  " +
            chalk.bold.yellow(pad(String(r.symbol), 10)) +
            "  " +
            colorPct(r.priceChangeH1 as number).padStart(20) +
            "  " +
            pad(fmtUsd(r.volumeH24 as number), 14, true) +
            "  " +
            pad(String(r.txnsH1), 7, true) +
            "  " +
            pad(fmtUsd(r.liquidityUsd as number), 14, true),
        );
      }
      if (top.length === 0) {
        lines.push(chalk.yellow("  No AI tokens matched filters."));
      }
      lines.push("");
      process.stdout.write(lines.join("\n"));
    } finally {
      await client.close();
    }
  });

// ── top-new ──────────────────────────────────────────────────────────────────

program
  .command("top-new")
  .description("New coins")
  .option("--chain <chain>", "Chain ID", "base")
  .option("--days <n>", "Lookback window in days", parseInt, 7)
  .option("--limit <n>", "Max rows to show", parseInt, 10)
  .option("--profile <name>", "Filter profile: strict/balanced/discovery", "balanced")
  .option("--json", "Output machine-readable JSON", false)
  .action(async (opts) => {
    const chain = opts.chain.toLowerCase().trim();
    const windowMs = Math.max(opts.days, 1) * 24 * 3600 * 1000;
    const nowMs = Date.now();
    const cutoffMs = nowMs - windowMs;
    const resolved = resolveScanProfile(opts.profile, [chain]);

    const client = new DexplorerClient();
    try {
      const allRows: Record<string, unknown>[] = [];
      for (const query of NEW_TOKEN_SEARCH_QUERIES) {
        try {
          const rows = await client.searchPairs(query);
          allRows.push(...rows);
        } catch {
          continue;
        }
      }

      // Filter and dedup
      const pairDedup = new Map<string, any>();
      for (const row of allRows) {
        if (String((row as any).chainId ?? "").toLowerCase() !== chain) continue;
        const pairCreatedAt = (row as any).pairCreatedAt;
        if (pairCreatedAt == null) continue;
        const createdMs = parseInt(String(pairCreatedAt), 10);
        if (isNaN(createdMs) || createdMs < cutoffMs) continue;

        const pairAddr = String((row as any).pairAddress ?? "").toLowerCase();
        const vol = parseFloat(((row as any).volume?.h24 ?? 0) as string) || 0;
        const prev = pairDedup.get(pairAddr);
        if (!prev || vol > (parseFloat((prev.volume?.h24 ?? 0) as string) || 0)) {
          pairDedup.set(pairAddr, row);
        }
      }

      // Token dedup
      const tokenDedup = new Map<string, any>();
      for (const p of Array.from(pairDedup.values())) {
        const base = (p as any).baseToken ?? {};
        const tokenKey = String(base.address ?? "").toLowerCase();
        if (!tokenKey) continue;
        const vol = parseFloat(((p as any).volume?.h24 ?? 0) as string) || 0;
        const prev = tokenDedup.get(tokenKey);
        if (!prev || vol > (parseFloat((prev.volume?.h24 ?? 0) as string) || 0)) {
          tokenDedup.set(tokenKey, p);
        }
      }

      const rows: Record<string, unknown>[] = [];
      for (const p of Array.from(tokenDedup.values())) {
        const base = (p as any).baseToken ?? {};
        const vol24 = parseFloat(((p as any).volume?.h24 ?? 0) as string) || 0;
        const liq = parseFloat(((p as any).liquidity?.usd ?? 0) as string) || 0;
        if (vol24 < resolved.minVol) continue;
        if (liq < resolved.minLiq) continue;
        const txH1 = (p as any).txns?.h1 ?? {};
        const buys = parseInt(txH1.buys ?? "0", 10) || 0;
        const sells = parseInt(txH1.sells ?? "0", 10) || 0;
        const createdMs = parseInt(String((p as any).pairCreatedAt), 10) || 0;
        const ageH = (nowMs - createdMs) / 3_600_000;

        rows.push({
          chainId: chain,
          symbol: String(base.symbol ?? "?"),
          name: String(base.name ?? "?"),
          tokenAddress: String(base.address ?? ""),
          priceUsd: parseFloat((p as any).priceUsd ?? "0") || 0,
          priceChangeH1: parseFloat(((p as any).priceChange?.h1 ?? 0) as string) || 0,
          priceChangeH24: parseFloat(((p as any).priceChange?.h24 ?? 0) as string) || 0,
          volumeH24: vol24,
          liquidityUsd: liq,
          txnsH1: buys + sells,
          ageHours: ageH,
          pairUrl: String((p as any).url ?? ""),
        });
      }

      rows.sort((a, b) => (b.volumeH24 as number) - (a.volumeH24 as number));
      const top = rows.slice(0, opts.limit);

      if (opts.json) {
        console.log(JSON.stringify(top, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push("");
      lines.push(
        chalk.bold.white("=== Top New Coins ===") +
          chalk.gray(
            `  chain=${chain} window=${opts.days}d profile=${opts.profile}`,
          ),
      );
      lines.push("");

      const header = [
        pad("#", 4, true),
        pad("Token", 10),
        pad("Age", 7, true),
        pad("1h%", 10, true),
        pad("24h Vol", 14, true),
        pad("Txns", 7, true),
        pad("Liq", 14, true),
      ].join("  ");
      lines.push(chalk.bold.white(header));
      lines.push(chalk.gray("-".repeat(75)));

      for (let i = 0; i < top.length; i++) {
        const r = top[i];
        const ageH = r.ageHours as number;
        const ageStr = ageH < 1 ? `${(ageH * 60).toFixed(0)}m` : ageH < 24 ? `${ageH.toFixed(1)}h` : `${(ageH / 24).toFixed(1)}d`;
        lines.push(
          pad(String(i + 1), 4, true) +
            "  " +
            chalk.bold.yellow(pad(String(r.symbol), 10)) +
            "  " +
            chalk.cyan(pad(ageStr, 7, true)) +
            "  " +
            colorPct(r.priceChangeH1 as number).padStart(20) +
            "  " +
            pad(fmtUsd(r.volumeH24 as number), 14, true) +
            "  " +
            pad(String(r.txnsH1), 7, true) +
            "  " +
            pad(fmtUsd(r.liquidityUsd as number), 14, true),
        );
      }
      if (top.length === 0) {
        lines.push(chalk.yellow("  No new coins matched filters."));
      }
      lines.push("");
      process.stdout.write(lines.join("\n"));
    } finally {
      await client.close();
    }
  });

// ── orders ───────────────────────────────────────────────────────────────────

program
  .command("orders <chain> <token>")
  .description("Inspect boost/profile orders for a token")
  .option("--json", "Output machine-readable JSON", false)
  .action(async (chain: string, token: string, opts) => {
    const client = new DexplorerClient();
    try {
      const orders = await client.getOrders(chain, token);
      if (opts.json) {
        console.log(JSON.stringify(orders, null, 2));
        return;
      }

      const lines: string[] = [];
      lines.push("");
      lines.push(chalk.bold.white("=== Token Orders ==="));
      lines.push(`  ${chalk.bold("Chain:")} ${chain}  ${chalk.bold("Token:")} ${token}`);
      lines.push("");

      const orderList: any[] = (orders as any).orders ?? [];
      const boostList: any[] = (orders as any).boosts ?? [];

      if (orderList.length === 0 && boostList.length === 0) {
        lines.push(chalk.yellow("  No orders or boosts found."));
      } else {
        if (orderList.length > 0) {
          lines.push(chalk.bold("  Orders:"));
          for (const o of orderList) {
            lines.push(
              `    type=${o.type ?? "?"} status=${o.status ?? "?"} paymentTimestamp=${o.paymentTimestamp ?? "?"}`,
            );
          }
        }
        if (boostList.length > 0) {
          lines.push(chalk.bold("  Boosts:"));
          const totalBoost = boostList.reduce(
            (s: number, b: any) => s + (parseFloat(b.amount) || 0),
            0,
          );
          lines.push(`    Total: ${totalBoost.toFixed(0)}  Count: ${boostList.length}`);
          for (const b of boostList.slice(0, 10)) {
            lines.push(
              `    amount=${b.amount ?? 0} type=${b.type ?? "?"} chainId=${b.chainId ?? "?"}`,
            );
          }
          if (boostList.length > 10) {
            lines.push(chalk.gray(`    ... and ${boostList.length - 10} more`));
          }
        }
      }
      lines.push("");
      process.stdout.write(lines.join("\n"));
    } finally {
      await client.close();
    }
  });

// ── preset ───────────────────────────────────────────────────────────────────

const presetCmd = program.command("preset").description("Save and reuse named scan filter presets");

presetCmd
  .command("save <name>")
  .description("Save a named preset from filters")
  .option("--chains <chains>", "Comma-separated chain IDs")
  .option("--limit <n>", "Number of rows", parseInt)
  .option("--min-liquidity-usd <n>", "Minimum pair liquidity in USD", parseFloat)
  .option("--min-volume-h24-usd <n>", "Minimum 24h volume in USD", parseFloat)
  .option("--min-txns-h1 <n>", "Minimum 1h transactions", parseInt)
  .option("--min-price-change-h1 <n>", "Minimum 1h price change percent", parseFloat)
  .action((name: string, opts) => {
    const filters = resolvedFilters({
      chains: opts.chains,
      limit: opts.limit,
      minLiquidityUsd: opts.minLiquidityUsd,
      minVolumeH24Usd: opts.minVolumeH24Usd,
      minTxnsH1: opts.minTxnsH1,
      minPriceChangeH1: opts.minPriceChangeH1,
    });
    const store = new StateStore();
    const preset = scanPresetFromFilters(name, filters);
    store.savePreset(preset);
    process.stdout.write(chalk.green(`Saved preset '${name}'.\n`));
  });

presetCmd
  .command("list")
  .description("List saved presets")
  .action(() => {
    const store = new StateStore();
    const presets = store.listPresets();
    if (presets.length === 0) {
      process.stdout.write(chalk.yellow("No presets found.\n"));
      return;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold.white("=== Presets ==="));
    lines.push("");

    const header = [
      pad("Name", 16),
      pad("Chains", 30),
      pad("Limit", 6, true),
      pad("MinLiq", 10, true),
      pad("MinVol24", 10, true),
      pad("MinTx1h", 8, true),
      pad("Updated", 25),
    ].join("  ");
    lines.push(chalk.bold.white(header));
    lines.push(chalk.gray("-".repeat(110)));

    for (const p of presets) {
      lines.push(
        chalk.cyan(pad(p.name, 16)) +
          "  " +
          pad(p.chains.join(","), 30) +
          "  " +
          pad(String(p.limit), 6, true) +
          "  " +
          pad(fmtUsd(p.minLiquidityUsd), 10, true) +
          "  " +
          pad(fmtUsd(p.minVolumeH24Usd), 10, true) +
          "  " +
          pad(String(p.minTxnsH1), 8, true) +
          "  " +
          chalk.gray(pad(p.updatedAt, 25)),
      );
    }
    lines.push("");
    process.stdout.write(lines.join("\n"));
  });

presetCmd
  .command("delete <name>")
  .description("Delete a preset")
  .action((name: string) => {
    const store = new StateStore();
    const deleted = store.deletePreset(name);
    if (!deleted) {
      process.stderr.write(chalk.red(`Preset '${name}' not found.\n`));
      process.exit(1);
    }
    process.stdout.write(chalk.green(`Deleted preset '${name}'.\n`));
  });

// ── task ─────────────────────────────────────────────────────────────────────

const taskCmd = program.command("task").description("Manage repeatable scan tasks");

taskCmd
  .command("create <name>")
  .description("Create a new scan task")
  .option("--preset <name>", "Preset name to base task on")
  .option("--chains <chains>", "Inline chain override")
  .option("--limit <n>", "Inline limit override", parseInt)
  .option("--min-liquidity-usd <n>", "Inline min liquidity override", parseFloat)
  .option("--min-volume-h24-usd <n>", "Inline min volume override", parseFloat)
  .option("--min-txns-h1 <n>", "Inline min txns override", parseInt)
  .option("--min-price-change-h1 <n>", "Inline min 1h% override", parseFloat)
  .option("--interval-seconds <n>", "Run interval seconds", parseInt)
  .option("--notes <text>", "Task notes", "")
  .action((name: string, opts) => {
    const store = new StateStore();
    if (opts.preset && !store.getPreset(opts.preset)) {
      process.stderr.write(chalk.red(`Preset '${opts.preset}' not found.\n`));
      process.exit(1);
    }

    const overrides: Record<string, any> = {};
    if (opts.chains) overrides.chains = parseChains(opts.chains);
    if (opts.limit != null) overrides.limit = opts.limit;
    if (opts.minLiquidityUsd != null)
      overrides.minLiquidityUsd = opts.minLiquidityUsd;
    if (opts.minVolumeH24Usd != null)
      overrides.minVolumeH24Usd = opts.minVolumeH24Usd;
    if (opts.minTxnsH1 != null) overrides.minTxnsH1 = opts.minTxnsH1;
    if (opts.minPriceChangeH1 != null)
      overrides.minPriceChangeH1 = opts.minPriceChangeH1;

    try {
      const task = store.createTask({
        name,
        preset: opts.preset ?? null,
        filters: Object.keys(overrides).length > 0 ? overrides : null,
        intervalSeconds: opts.intervalSeconds ?? null,
        alerts: null,
        notes: opts.notes,
      });
      process.stdout.write(
        chalk.green(`Created task '${task.name}' (${task.id}).\n`),
      );
    } catch (err: any) {
      process.stderr.write(chalk.red(`${err.message}\n`));
      process.exit(1);
    }
  });

taskCmd
  .command("list")
  .description("List tasks")
  .action(() => {
    const store = new StateStore();
    const tasks = store.listTasks();
    if (tasks.length === 0) {
      process.stdout.write(chalk.yellow("No tasks found.\n"));
      return;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold.white("=== Scan Tasks ==="));
    lines.push("");

    const header = [
      pad("ID", 12),
      pad("Name", 20),
      pad("Status", 10),
      pad("Preset", 12),
      pad("Interval", 10, true),
      pad("Alerts", 8),
      pad("Last Run", 25),
      pad("Updated", 25),
    ].join("  ");
    lines.push(chalk.bold.white(header));
    lines.push(chalk.gray("-".repeat(130)));

    for (const t of tasks) {
      const statusColor =
        t.status === "done"
          ? chalk.green
          : t.status === "blocked"
            ? chalk.red
            : t.status === "running"
              ? chalk.cyan
              : chalk.yellow;

      lines.push(
        chalk.cyan(pad(t.id, 12)) +
          "  " +
          pad(t.name, 20) +
          "  " +
          statusColor(pad(t.status, 10)) +
          "  " +
          pad(t.preset ?? "-", 12) +
          "  " +
          pad(
            t.intervalSeconds != null ? String(t.intervalSeconds) : "-",
            10,
            true,
          ) +
          "  " +
          pad(t.alerts ? chalk.green("yes") : chalk.gray("no"), 8) +
          "  " +
          chalk.gray(pad(t.lastRunAt ?? "-", 25)) +
          "  " +
          chalk.gray(pad(t.updatedAt, 25)),
      );
    }
    lines.push("");
    process.stdout.write(lines.join("\n"));
  });

taskCmd
  .command("run <name>")
  .description("Run a task once")
  .option("--json", "Output machine-readable JSON", false)
  .action(async (nameOrId: string, opts) => {
    const store = new StateStore();
    const task = store.getTask(nameOrId);
    if (!task) {
      process.stderr.write(chalk.red(`Task '${nameOrId}' not found.\n`));
      process.exit(1);
    }

    // Resolve filters from task
    let filters = defaultScanFilters();
    if (task.preset) {
      const preset = store.getPreset(task.preset);
      if (preset) filters = scanPresetToFilters(preset);
    }
    if (task.filters) {
      const f = task.filters;
      if (f.chains) filters.chains = Array.isArray(f.chains) ? f.chains : parseChains(String(f.chains));
      if (f.limit != null) filters.limit = Number(f.limit);
      if (f.minLiquidityUsd != null) filters.minLiquidityUsd = Number(f.minLiquidityUsd);
      if (f.minVolumeH24Usd != null) filters.minVolumeH24Usd = Number(f.minVolumeH24Usd);
      if (f.minTxnsH1 != null) filters.minTxnsH1 = Number(f.minTxnsH1);
      if (f.minPriceChangeH1 != null) filters.minPriceChangeH1 = Number(f.minPriceChangeH1);
    }

    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const candidates = await scanner.scan(filters);
      store.touchTaskRun(task.id);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              task: scanTaskToDict(task),
              results: candidates.map(candidateJson),
              ok: true,
            },
            null,
            2,
          ),
        );
        return;
      }
      process.stdout.write(renderHotTable(candidates, filters));
    } catch (err: any) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { task: scanTaskToDict(task), ok: false, error: err.message },
            null,
            2,
          ),
        );
      } else {
        process.stderr.write(chalk.red(`Task run failed: ${err.message}\n`));
      }
      process.exit(1);
    } finally {
      await client.close();
    }
  });

taskCmd
  .command("delete <name>")
  .description("Delete a task")
  .action((nameOrId: string) => {
    const store = new StateStore();
    const deleted = store.deleteTask(nameOrId);
    if (!deleted) {
      process.stderr.write(chalk.red(`Task '${nameOrId}' not found.\n`));
      process.exit(1);
    }
    process.stdout.write(chalk.green(`Deleted task '${nameOrId}'.\n`));
  });

// ── state ────────────────────────────────────────────────────────────────────

const stateCmd = program
  .command("state")
  .description("Import/export local presets, tasks, and run history");

stateCmd
  .command("export")
  .description("Export state bundle to stdout as JSON")
  .action(() => {
    const store = new StateStore();
    const bundle = store.exportBundle();
    console.log(JSON.stringify(bundle, null, 2));
  });

stateCmd
  .command("import <file>")
  .description("Import state bundle from a JSON file")
  .action((file: string) => {
    const store = new StateStore();
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(chalk.red(`File not found: ${resolved}\n`));
      process.exit(1);
    }
    const text = fs.readFileSync(resolved, "utf-8");
    let bundle: Record<string, any>;
    try {
      bundle = JSON.parse(text);
    } catch {
      process.stderr.write(chalk.red("Invalid JSON file.\n"));
      process.exit(1);
    }
    try {
      const stats = store.importBundle(bundle);
      process.stdout.write(
        chalk.green(
          `Imported: ${stats.presets} presets, ${stats.tasks} tasks, ${stats.runs} runs.\n`,
        ),
      );
    } catch (err: any) {
      process.stderr.write(chalk.red(`Import failed: ${err.message}\n`));
      process.exit(1);
    }
  });

// ── doctor ───────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Diagnostic health check")
  .action(async () => {
    const lines: string[] = [];
    lines.push("");
    lines.push(chalk.bold.white("=== Dexplorer Doctor ==="));
    lines.push("");

    const checks: Array<[string, boolean, string]> = [];

    // 1. Node.js version
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    checks.push([
      "Node.js >= 18",
      nodeMajor >= 18,
      `v${process.versions.node}`,
    ]);

    // 2. API connectivity
    try {
      const resp = await fetch(
        "https://api.dexscreener.com/token-boosts/top/v1",
        { signal: AbortSignal.timeout(10_000) },
      );
      checks.push([
        "Dexscreener API",
        resp.status === 200,
        `HTTP ${resp.status}`,
      ]);
    } catch (err: any) {
      checks.push(["Dexscreener API", false, String(err.message).slice(0, 60)]);
    }

    // 3. MORALIS_API_KEY
    const moralisKey = process.env.MORALIS_API_KEY?.trim() ?? "";
    checks.push([
      "MORALIS_API_KEY",
      Boolean(moralisKey),
      moralisKey ? "set" : "not set (optional)",
    ]);

    // 4. Default preset
    const store = new StateStore();
    const defaultPreset = store.getPreset("default");
    checks.push([
      "Default preset",
      defaultPreset != null,
      defaultPreset ? "configured" : "not set (run setup)",
    ]);

    // 5. State directory
    const stateDir = path.join(os.homedir(), ".dexplorer-cli");
    checks.push(["State dir", fs.existsSync(stateDir), stateDir]);

    // Render
    for (const [label, ok, detail] of checks) {
      const status = ok
        ? chalk.bold.green("PASS")
        : chalk.bold.yellow("WARN");
      lines.push(`  ${status}  ${pad(label, 20)}  ${chalk.gray(detail)}`);
    }

    const fails = checks.filter(([, ok]) => !ok).length;
    lines.push("");
    if (fails === 0) {
      lines.push(chalk.bold.green("All checks passed! Your scanner is ready."));
    } else {
      lines.push(chalk.bold.yellow(`${fails} warning(s). See details above.`));
    }
    lines.push("");
    process.stdout.write(lines.join("\n"));
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse();
