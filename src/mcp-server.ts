#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_CHAINS, ScanFilters, defaultScanFilters } from "./config.js";
import { DexplorerClient } from "./client.js";
import { HotScanner } from "./scanner.js";
import { HotTokenCandidate, PairSnapshot, txnsH1, ageHours } from "./models.js";
import { buildDistributionHeuristics } from "./scoring.js";
import {
  StateStore,
  ScanPreset,
  scanPresetFromFilters,
  scanPresetToDict,
  scanTaskToDict,
  taskRunRecordToDict,
} from "./state.js";
import { sendTestAlert, validateWebhookUrl } from "./alerts.js";
import { executeTaskOnce, selectDueTasks } from "./task-runner.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _MAX_NAME_LEN = 200;
const _MAX_TEMPLATE_LEN = 2000;
const _MAX_CHAINS_LEN = 500;
const _MAX_NOTES_LEN = 1000;
const _MAX_LIMIT = 100;
const _MAX_INTERVAL_SECONDS = 86_400;
const _MAX_TASK_RUNS = 500;
const _MAX_IMPORT_PRESETS = 100;
const _MAX_IMPORT_TASKS = 500;
const _MAX_IMPORT_RUNS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampStr(value: string, maxLen: number, _label: string): string {
  if (value.length > maxLen) {
    return value.slice(0, maxLen);
  }
  return value;
}

function boundedInt(value: number, min: number, max: number, label: string): number {
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function boundedFloat(value: number, min: number, max?: number, label?: string): number {
  if (value < min) {
    throw new Error(`${label} must be >= ${min}`);
  }
  if (max != null && value > max) {
    throw new Error(`${label} must be <= ${max}`);
  }
  return value;
}

function parseChains(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_CHAINS];
  raw = clampStr(raw, _MAX_CHAINS_LEN, "chains");
  const values = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return values.length > 0 ? values : [...DEFAULT_CHAINS];
}

function asList(value: string | string[] | undefined | null): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [String(value)];
}

function serializeCandidate(c: HotTokenCandidate): Record<string, unknown> {
  const pair = c.pair;
  const analytics = c.analytics;
  return {
    chainId: pair.chainId,
    tokenAddress: pair.baseAddress,
    tokenSymbol: pair.baseSymbol,
    tokenName: pair.baseName,
    pairAddress: pair.pairAddress,
    pairUrl: pair.pairUrl,
    dexId: pair.dexId,
    priceUsd: pair.priceUsd,
    priceChangeH1: pair.priceChangeH1,
    priceChangeH24: pair.priceChangeH24,
    volumeH24: pair.volumeH24,
    volumeH1: pair.volumeH1,
    txnsH1: txnsH1(pair),
    liquidityUsd: pair.liquidityUsd,
    marketCap: pair.marketCap,
    fdv: pair.fdv,
    holdersCount: pair.holdersCount,
    holdersSource: pair.holdersSource,
    ageHours: ageHours(pair),
    boostTotal: c.boostTotal,
    boostCount: c.boostCount,
    hasProfile: c.hasProfile,
    discovery: c.discovery,
    score: c.score,
    tags: c.tags,
    analytics: {
      volumeToLiquidity: analytics.volumeToLiquidity,
      buyPressure: analytics.buyPressure,
      spreadH1H24: analytics.spreadH1H24,
      momentumM5H1: analytics.momentumM5H1,
      holderScore: analytics.holderScore,
      ageScore: analytics.ageScore,
    },
  };
}

function buildAlertConfig(opts: {
  webhookUrl?: string;
  discordWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  alertMinScore?: number;
  alertCooldownSeconds?: number;
  alertTemplate?: string;
  alertTopN?: number;
  alertMinLiquidityUsd?: number;
  alertMaxVolLiqRatio?: number;
  alertBlockedTerms?: string;
  alertBlockedChains?: string;
  webhookExtra?: string;
}): Record<string, unknown> | null {
  const alerts: Record<string, unknown> = {};
  if (opts.webhookUrl != null) alerts.webhook_url = opts.webhookUrl;
  if (opts.discordWebhookUrl != null) alerts.discord_webhook_url = opts.discordWebhookUrl;
  if (opts.telegramBotToken != null) alerts.telegram_bot_token = opts.telegramBotToken;
  if (opts.telegramChatId != null) alerts.telegram_chat_id = opts.telegramChatId;
  if (opts.alertMinScore != null) alerts.min_score = opts.alertMinScore;
  if (opts.alertCooldownSeconds != null) alerts.cooldown_seconds = opts.alertCooldownSeconds;
  if (opts.alertTemplate != null) alerts.template = opts.alertTemplate;
  if (opts.alertTopN != null) alerts.top_n = opts.alertTopN;
  if (opts.alertMinLiquidityUsd != null) alerts.min_liquidity_usd = opts.alertMinLiquidityUsd;
  if (opts.alertMaxVolLiqRatio != null) alerts.max_vol_liq_ratio = opts.alertMaxVolLiqRatio;
  const terms = asList(opts.alertBlockedTerms);
  if (terms.length > 0) alerts.blocked_terms = terms;
  const chains = asList(opts.alertBlockedChains).map((c) => c.toLowerCase());
  if (chains.length > 0) alerts.blocked_chains = chains;
  if (opts.webhookExtra != null) {
    try {
      alerts.webhook_extra = JSON.parse(opts.webhookExtra);
    } catch {
      // ignore invalid JSON
    }
  }
  return Object.keys(alerts).length > 0 ? alerts : null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "dexplorer-cli-mcp-tool", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Tool: scan_hot_tokens
// ---------------------------------------------------------------------------

server.tool(
  "scan_hot_tokens",
  "Scan and rank the hottest tokens on Dexscreener right now. " +
    "Discovers tokens from Dexscreener boosts and profiles, scores them by volume, " +
    "liquidity, momentum, and flow pressure, then returns ranked results. " +
    "All data comes from free public APIs (Dexscreener, GeckoTerminal, Blockscout, Honeypot.is). " +
    "Use this when a user asks: \"what's hot\", \"show me trending tokens\", " +
    "\"find tokens on solana\", \"what should I look at\", \"find degen plays\", etc. " +
    "Built-in profile presets: Discovery (degen): min_liquidity=8000, min_volume=10000, min_txns=5; " +
    "Balanced (standard): min_liquidity=20000, min_volume=40000, min_txns=25; " +
    "Strict (conservative): min_liquidity=35000, min_volume=90000, min_txns=50. " +
    "Score ranges: 80+ = very hot, 60-80 = interesting, 40-60 = moderate, <40 = weak.",
  {
    chains: z.string().default(DEFAULT_CHAINS.join(",")).describe("Comma-separated chain IDs (solana, base, ethereum, bsc, arbitrum)."),
    limit: z.number().default(20).describe("Max number of tokens to return (default 20)."),
    minLiquidityUsd: z.number().default(20_000).describe("Minimum pair liquidity in USD."),
    minVolumeH24Usd: z.number().default(40_000).describe("Minimum 24h trading volume in USD."),
    minTxnsH1: z.number().default(30).describe("Minimum transactions in the last hour."),
    minPriceChangeH1: z.number().default(-10).describe("Minimum 1h price change percent (use negative to allow dips)."),
  },
  async (args) => {
    const limit = boundedInt(args.limit, 1, _MAX_LIMIT, "limit");
    const minLiquidityUsd = boundedFloat(args.minLiquidityUsd, 0, undefined, "minLiquidityUsd");
    const minVolumeH24Usd = boundedFloat(args.minVolumeH24Usd, 0, undefined, "minVolumeH24Usd");
    const minTxnsH1 = boundedInt(args.minTxnsH1, 0, 1_000_000, "minTxnsH1");
    const chainIds = args.chains
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);

    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const filters: ScanFilters = {
        chains: chainIds.length > 0 ? chainIds : [...DEFAULT_CHAINS],
        limit,
        minLiquidityUsd,
        minVolumeH24Usd,
        minTxnsH1,
        minPriceChangeH1: args.minPriceChangeH1,
      };
      const rows = await scanner.scan(filters);
      return { content: [{ type: "text", text: JSON.stringify(rows.map(serializeCandidate)) }] };
    } finally {
      await client.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_rate_budget_stats
// ---------------------------------------------------------------------------

server.tool(
  "get_rate_budget_stats",
  "Check API rate limit usage and remaining budget. " +
    "Use this to verify API health or debug rate limiting issues. " +
    "Returns request counts, remaining budget, and timing info.",
  {
    query: z.string().default("solana").describe("Search query to exercise the API."),
    chainId: z.string().default("solana").describe("Chain ID for token lookup."),
    tokenAddress: z.string().optional().describe("Optional token address to look up."),
  },
  async (args) => {
    const client = new DexplorerClient();
    try {
      if (args.query.trim()) {
        try {
          await client.searchPairs(args.query.trim());
        } catch {
          // ignore
        }
      }
      if (args.tokenAddress) {
        try {
          await client.getTokenPairs(args.chainId.trim().toLowerCase(), args.tokenAddress.trim());
        } catch {
          // ignore
        }
      }
      const stats = await client.getRuntimeStats();
      return { content: [{ type: "text", text: JSON.stringify(stats) }] };
    } finally {
      await client.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: save_preset
// ---------------------------------------------------------------------------

server.tool(
  "save_preset",
  "Save a named scan preset with custom filter thresholds. " +
    "Presets let you save and reuse filter configurations. " +
    "Use this when a user says \"save these settings\", \"create a preset\", etc. " +
    "The preset named \"default\" is auto-loaded on every scan.",
  {
    name: z.string().describe("Preset name."),
    chains: z.string().default(DEFAULT_CHAINS.join(",")).describe("Comma-separated chain IDs."),
    limit: z.number().default(20).describe("Max results."),
    minLiquidityUsd: z.number().default(20_000).describe("Minimum liquidity USD."),
    minVolumeH24Usd: z.number().default(40_000).describe("Minimum 24h volume USD."),
    minTxnsH1: z.number().default(30).describe("Minimum txns in last hour."),
    minPriceChangeH1: z.number().default(-10).describe("Minimum 1h price change percent."),
  },
  async (args) => {
    const name = clampStr(args.name, _MAX_NAME_LEN, "name");
    const limit = boundedInt(args.limit, 1, _MAX_LIMIT, "limit");
    const minLiquidityUsd = boundedFloat(args.minLiquidityUsd, 0, undefined, "minLiquidityUsd");
    const minVolumeH24Usd = boundedFloat(args.minVolumeH24Usd, 0, undefined, "minVolumeH24Usd");
    const minTxnsH1 = boundedInt(args.minTxnsH1, 0, 1_000_000, "minTxnsH1");

    const filters: ScanFilters = {
      chains: parseChains(args.chains),
      limit,
      minLiquidityUsd,
      minVolumeH24Usd,
      minTxnsH1,
      minPriceChangeH1: args.minPriceChangeH1,
    };
    const store = new StateStore();
    const preset = store.savePreset(scanPresetFromFilters(name, filters));
    return { content: [{ type: "text", text: JSON.stringify(scanPresetToDict(preset)) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_presets
// ---------------------------------------------------------------------------

server.tool(
  "list_presets",
  "List all saved scan presets with their filter configurations. " +
    "Use this to see what presets are available before scanning.",
  {},
  async () => {
    const store = new StateStore();
    const presets = store.listPresets().map(scanPresetToDict);
    return { content: [{ type: "text", text: JSON.stringify(presets) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: create_task
// ---------------------------------------------------------------------------

server.tool(
  "create_task",
  "Create a scheduled scan task with optional alert channels. " +
    "Tasks run on a schedule and can send alerts to Discord, Telegram, or webhooks " +
    "when they find tokens above a score threshold. " +
    "Use this when a user says \"set up alerts\", \"monitor for new tokens\", " +
    "\"notify me when something hot appears\", etc.",
  {
    name: z.string().describe("Task name."),
    preset: z.string().optional().describe("Name of a saved preset to use as baseline filters."),
    chains: z.string().optional().describe("Comma-separated chain IDs (overrides preset)."),
    limit: z.number().optional().describe("Max results (overrides preset)."),
    minLiquidityUsd: z.number().optional().describe("Min liquidity USD (overrides preset)."),
    minVolumeH24Usd: z.number().optional().describe("Min 24h volume USD (overrides preset)."),
    minTxnsH1: z.number().optional().describe("Min txns in last hour (overrides preset)."),
    minPriceChangeH1: z.number().optional().describe("Min 1h price change percent (overrides preset)."),
    intervalSeconds: z.number().optional().describe("Seconds between scheduled runs (15-86400)."),
    webhookUrl: z.string().optional().describe("Generic webhook URL for alerts."),
    discordWebhookUrl: z.string().optional().describe("Discord webhook URL for alerts."),
    telegramBotToken: z.string().optional().describe("Telegram bot token for alerts."),
    telegramChatId: z.string().optional().describe("Telegram chat ID for alerts."),
    alertMinScore: z.number().optional().describe("Minimum score to trigger an alert (0-100)."),
    alertCooldownSeconds: z.number().optional().describe("Seconds between repeated alerts (0-86400)."),
    alertTemplate: z.string().optional().describe("Custom alert message template."),
    alertTopN: z.number().optional().describe("Number of top tokens to include in alerts (1-10)."),
    alertMinLiquidityUsd: z.number().optional().describe("Min liquidity USD for alert filtering."),
    alertMaxVolLiqRatio: z.number().optional().describe("Max volume/liquidity ratio for alert filtering."),
    alertBlockedTerms: z.string().optional().describe("Comma-separated blocked terms for alert filtering."),
    alertBlockedChains: z.string().optional().describe("Comma-separated blocked chains for alert filtering."),
    webhookExtra: z.string().optional().describe("Extra JSON payload to include in webhook alerts."),
    notes: z.string().default("").describe("Optional notes for the task."),
  },
  async (args) => {
    const name = clampStr(args.name, _MAX_NAME_LEN, "name");
    const notes = clampStr(args.notes, _MAX_NOTES_LEN, "notes");
    let presetName = args.preset;
    if (presetName) presetName = clampStr(presetName, _MAX_NAME_LEN, "preset");
    let alertTemplate = args.alertTemplate;
    if (alertTemplate) alertTemplate = clampStr(alertTemplate, _MAX_TEMPLATE_LEN, "alertTemplate");

    // Validate webhook URLs
    if (args.webhookUrl) validateWebhookUrl(args.webhookUrl);
    if (args.discordWebhookUrl) validateWebhookUrl(args.discordWebhookUrl);

    const store = new StateStore();
    if (presetName && !store.getPreset(presetName)) {
      throw new Error(`Preset '${presetName}' not found`);
    }

    const overrides: Record<string, unknown> = {};
    if (args.chains) {
      overrides.chains = parseChains(args.chains);
    }
    if (args.limit != null) {
      overrides.limit = boundedInt(args.limit, 1, _MAX_LIMIT, "limit");
    }
    if (args.minLiquidityUsd != null) {
      overrides.min_liquidity_usd = boundedFloat(args.minLiquidityUsd, 0, undefined, "minLiquidityUsd");
    }
    if (args.minVolumeH24Usd != null) {
      overrides.min_volume_h24_usd = boundedFloat(args.minVolumeH24Usd, 0, undefined, "minVolumeH24Usd");
    }
    if (args.minTxnsH1 != null) {
      overrides.min_txns_h1 = boundedInt(args.minTxnsH1, 0, 1_000_000, "minTxnsH1");
    }
    if (args.minPriceChangeH1 != null) {
      overrides.min_price_change_h1 = args.minPriceChangeH1;
    }

    let intervalSeconds = args.intervalSeconds;
    if (intervalSeconds != null) {
      intervalSeconds = boundedInt(intervalSeconds, 15, _MAX_INTERVAL_SECONDS, "intervalSeconds");
    }

    let alertCooldownSeconds = args.alertCooldownSeconds;
    if (alertCooldownSeconds != null) {
      alertCooldownSeconds = boundedInt(alertCooldownSeconds, 0, _MAX_INTERVAL_SECONDS, "alertCooldownSeconds");
    }
    let alertTopN = args.alertTopN;
    if (alertTopN != null) {
      alertTopN = boundedInt(alertTopN, 1, 10, "alertTopN");
    }
    let alertMinScore = args.alertMinScore;
    if (alertMinScore != null) {
      alertMinScore = boundedFloat(alertMinScore, 0, 100, "alertMinScore");
    }
    let alertMinLiquidityUsd = args.alertMinLiquidityUsd;
    if (alertMinLiquidityUsd != null) {
      alertMinLiquidityUsd = boundedFloat(alertMinLiquidityUsd, 0, undefined, "alertMinLiquidityUsd");
    }
    let alertMaxVolLiqRatio = args.alertMaxVolLiqRatio;
    if (alertMaxVolLiqRatio != null) {
      alertMaxVolLiqRatio = boundedFloat(alertMaxVolLiqRatio, 0, undefined, "alertMaxVolLiqRatio");
    }

    const alerts = buildAlertConfig({
      webhookUrl: args.webhookUrl,
      discordWebhookUrl: args.discordWebhookUrl,
      telegramBotToken: args.telegramBotToken,
      telegramChatId: args.telegramChatId,
      alertMinScore,
      alertCooldownSeconds,
      alertTemplate,
      alertTopN,
      alertMinLiquidityUsd,
      alertMaxVolLiqRatio,
      alertBlockedTerms: args.alertBlockedTerms,
      alertBlockedChains: args.alertBlockedChains,
      webhookExtra: args.webhookExtra,
    });

    const task = store.createTask({
      name,
      preset: presetName ?? null,
      filters: Object.keys(overrides).length > 0 ? overrides : null,
      intervalSeconds: intervalSeconds ?? null,
      alerts,
      notes,
    });
    return { content: [{ type: "text", text: JSON.stringify(scanTaskToDict(task)) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_tasks
// ---------------------------------------------------------------------------

server.tool(
  "list_tasks",
  "List all scan tasks and their current status. " +
    "Shows task name, preset, interval, alert config, and status (todo/running/done/blocked).",
  {
    status: z.string().optional().describe("Filter by status: todo, running, done, or blocked."),
  },
  async (args) => {
    const store = new StateStore();
    if (args.status && !["todo", "running", "done", "blocked"].includes(args.status)) {
      return {
        content: [{ type: "text", text: JSON.stringify([{ error: "Invalid status. Use todo/running/done/blocked" }]) }],
      };
    }
    const rows = store.listTasks(args.status as any).map(scanTaskToDict);
    return { content: [{ type: "text", text: JSON.stringify(rows) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: run_task_scan
// ---------------------------------------------------------------------------

server.tool(
  "run_task_scan",
  "Run a scan task once and return scored token results. " +
    "Executes the task's filters, scores tokens, optionally fires alerts, " +
    "and records the run. Use this to manually trigger a task scan.",
  {
    task: z.string().describe("Task name or ID."),
    fireAlerts: z.boolean().default(true).describe("Whether to fire alerts if thresholds are met."),
  },
  async (args) => {
    const store = new StateStore();
    const row = store.getTask(args.task);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Task '${args.task}' not found` }) }] };
    }

    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const result = await executeTaskOnce({
        store,
        scanner,
        task: row,
        mode: "mcp-manual",
        fireAlerts: args.fireAlerts,
        markRunning: false,
        blockOnError: false,
      });
      const candidates: unknown[] = Array.isArray(result.candidates) ? result.candidates : [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: result.ok ?? false,
              error: result.error ?? null,
              task: result.task ?? scanTaskToDict(row),
              filters: result.filters ?? null,
              results: candidates
                .filter((c): c is HotTokenCandidate => c != null && typeof c === "object" && "pair" in c)
                .map(serializeCandidate),
              alert: result.alert ?? null,
              run: result.run ?? null,
            }),
          },
        ],
      };
    } finally {
      await client.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: run_due_tasks
// ---------------------------------------------------------------------------

server.tool(
  "run_due_tasks",
  "Run one scheduler cycle - executes all tasks that are due. " +
    "Checks each task's interval and last run time, runs due tasks, " +
    "fires alerts if thresholds are met, and records results.",
  {
    defaultIntervalSeconds: z.number().default(120).describe("Default interval in seconds for tasks without an explicit interval."),
    fireAlerts: z.boolean().default(true).describe("Whether to fire alerts if thresholds are met."),
  },
  async (args) => {
    const defaultIntervalSeconds = boundedInt(
      args.defaultIntervalSeconds,
      15,
      _MAX_INTERVAL_SECONDS,
      "defaultIntervalSeconds",
    );
    const store = new StateStore();
    const due = selectDueTasks({
      store,
      taskNameOrId: null,
      allTasks: true,
      defaultIntervalSeconds,
    });

    const cycleResults: Record<string, unknown>[] = [];
    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      for (const task of due) {
        const result = await executeTaskOnce({
          store,
          scanner,
          task,
          mode: "mcp-daemon",
          fireAlerts: args.fireAlerts,
          markRunning: true,
          blockOnError: true,
        });
        const candidates: unknown[] = Array.isArray(result.candidates) ? result.candidates : [];
        const validCandidates = candidates.filter(
          (c): c is HotTokenCandidate => c != null && typeof c === "object" && "pair" in c,
        );
        cycleResults.push({
          ok: result.ok ?? false,
          error: result.error ?? null,
          task: result.task ?? scanTaskToDict(task),
          resultCount: validCandidates.length,
          top: validCandidates.length > 0 ? serializeCandidate(validCandidates[0]) : null,
          alert: result.alert ?? null,
          run: result.run ?? null,
        });
      }
    } finally {
      await client.close();
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ dueTasks: due.length, runs: cycleResults }) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: test_task_alert
// ---------------------------------------------------------------------------

server.tool(
  "test_task_alert",
  "Send a test alert through a task's configured channels (Discord/Telegram/webhook). " +
    "Use this to verify alert delivery before relying on automated alerts. " +
    "Set withScan=true to include real scan data in the test alert.",
  {
    task: z.string().describe("Task name or ID."),
    withScan: z.boolean().default(false).describe("Whether to include real scan data in the test alert."),
  },
  async (args) => {
    const store = new StateStore();
    const row = store.getTask(args.task);
    if (!row) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Task '${args.task}' not found` }) }] };
    }

    let candidates: HotTokenCandidate[] = [];
    if (args.withScan) {
      const client = new DexplorerClient();
      try {
        const scanner = new HotScanner(client);
        const result = await executeTaskOnce({
          store,
          scanner,
          task: row,
          mode: "mcp-test-scan",
          fireAlerts: false,
          markRunning: false,
          blockOnError: false,
        });
        const rawCandidates = Array.isArray(result.candidates) ? result.candidates : [];
        candidates = rawCandidates.filter(
          (c): c is HotTokenCandidate => c != null && typeof c === "object" && "pair" in c,
        );
      } finally {
        await client.close();
      }
    }

    const alertResult = await sendTestAlert(row, candidates);
    if (alertResult.sent) {
      store.touchTaskAlert(row.id);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ task: scanTaskToDict(row), alert: alertResult }) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_task_runs
// ---------------------------------------------------------------------------

server.tool(
  "list_task_runs",
  "List historical task run records with results and timing. " +
    "Shows when each task ran, how many tokens were found, top score, and alert status.",
  {
    task: z.string().optional().describe("Filter by task name or ID."),
    limit: z.number().default(100).describe("Max number of run records to return."),
  },
  async (args) => {
    const limit = boundedInt(args.limit, 1, _MAX_TASK_RUNS, "limit");
    const store = new StateStore();
    const runs = store.listRuns(args.task ?? null, limit).map(taskRunRecordToDict);
    return { content: [{ type: "text", text: JSON.stringify(runs) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: export_state_bundle
// ---------------------------------------------------------------------------

server.tool(
  "export_state_bundle",
  "Export all presets, tasks, and run history as a single JSON bundle. " +
    "Use this for backup, sharing configurations, or migrating to another machine.",
  {},
  async () => {
    const store = new StateStore();
    const bundle = store.exportBundle();
    return { content: [{ type: "text", text: JSON.stringify(bundle) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: import_state_bundle
// ---------------------------------------------------------------------------

server.tool(
  "import_state_bundle",
  "Import presets, tasks, and runs from a previously exported bundle. " +
    "Mode 'merge' adds new items without removing existing ones. " +
    "Mode 'replace' overwrites everything with the bundle contents.",
  {
    bundle: z.string().describe("JSON string of the bundle to import."),
    mode: z.string().default("merge").describe("Import mode: 'merge' or 'replace'."),
  },
  async (args) => {
    if (args.mode !== "merge" && args.mode !== "replace") {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid mode. Use merge or replace." }) }] };
    }

    let bundleObj: Record<string, unknown>;
    try {
      bundleObj = JSON.parse(args.bundle);
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Bundle must be a valid JSON string" }) }] };
    }

    if (typeof bundleObj !== "object" || bundleObj === null || Array.isArray(bundleObj)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Bundle must be a JSON object" }) }] };
    }

    const presets = bundleObj.presets ?? [];
    const tasks = bundleObj.tasks ?? [];
    const runs = bundleObj.runs ?? [];

    if (!Array.isArray(presets) || !Array.isArray(tasks) || !Array.isArray(runs)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Bundle presets/tasks/runs must be arrays" }) }],
      };
    }
    if (presets.length > _MAX_IMPORT_PRESETS) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Bundle exceeds max ${_MAX_IMPORT_PRESETS} presets` }) }],
      };
    }
    if (tasks.length > _MAX_IMPORT_TASKS) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Bundle exceeds max ${_MAX_IMPORT_TASKS} tasks` }) }],
      };
    }
    if (runs.length > _MAX_IMPORT_RUNS) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Bundle exceeds max ${_MAX_IMPORT_RUNS} runs` }) }],
      };
    }

    const store = new StateStore();
    const counts = store.importBundle(bundleObj as Record<string, any>, args.mode as "merge" | "replace");
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, mode: args.mode, counts }) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: search_pairs
// ---------------------------------------------------------------------------

server.tool(
  "search_pairs",
  "Search for tokens on Dexscreener by name, symbol, or contract address. " +
    "Use this when a user asks \"find pepe\", \"search for <token>\", " +
    "\"look up this address\", etc. Returns matching pairs with price, " +
    "volume, liquidity, and pair URL.",
  {
    query: z.string().describe("Search query (token name, symbol, or address)."),
    limit: z.number().default(20).describe("Max number of results to return."),
  },
  async (args) => {
    const limit = boundedInt(args.limit, 1, _MAX_LIMIT, "limit");
    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const pairs = await scanner.search(args.query, limit);
      const result = pairs.map((p) => ({
        chainId: p.chainId,
        pairAddress: p.pairAddress,
        tokenAddress: p.baseAddress,
        tokenSymbol: p.baseSymbol,
        dexId: p.dexId,
        priceUsd: p.priceUsd,
        volumeH24: p.volumeH24,
        txnsH1: txnsH1(p),
        liquidityUsd: p.liquidityUsd,
        pairUrl: p.pairUrl,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } finally {
      await client.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: inspect_token
// ---------------------------------------------------------------------------

server.tool(
  "inspect_token",
  "Deep-dive inspection of a specific token by chain and address. " +
    "Returns the best trading pair, price data, volume, liquidity, market cap, " +
    "and concentration proxy analysis. Use this when a user provides a specific " +
    "token address and wants detailed information.",
  {
    chainId: z.string().describe("Chain ID (e.g. solana, base, ethereum)."),
    tokenAddress: z.string().describe("Token contract address."),
  },
  async (args) => {
    const client = new DexplorerClient();
    try {
      const scanner = new HotScanner(client);
      const pairs = await scanner.inspectToken(args.chainId, args.tokenAddress);
      if (!pairs || pairs.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Token not found or no pairs available" }) }],
        };
      }
      const best = pairs[0];
      const candidate: HotTokenCandidate = {
        pair: best,
        score: 0,
        boostTotal: 0,
        boostCount: 0,
        hasProfile: false,
        discovery: "inspect",
        tags: [],
        analytics: {
          volumeToLiquidity: best.volumeH24 / Math.max(best.liquidityUsd, 1),
          buyPressure: (best.buysH1 + best.sellsH1) > 0 ? best.buysH1 / (best.buysH1 + best.sellsH1) : 0,
          spreadH1H24:
            best.priceChangeH1 !== 0 && best.priceChangeH24 !== 0
              ? best.priceChangeH1 / Math.abs(best.priceChangeH24) || 0
              : 0,
          momentumM5H1: (best.volumeM5 * 12) / Math.max(best.volumeH1, 1),
          holderScore: best.holdersCount != null ? Math.min(best.holdersCount / 1000, 1) : 0,
          ageScore: (() => {
            const age = ageHours(best);
            return age != null ? Math.min(age / 168, 1) : 0.5;
          })(),
        },
      };
      const result = {
        bestPair: {
          chainId: best.chainId,
          pairAddress: best.pairAddress,
          pairUrl: best.pairUrl,
          tokenAddress: best.baseAddress,
          tokenSymbol: best.baseSymbol,
          priceUsd: best.priceUsd,
          volumeH24: best.volumeH24,
          txnsH1: txnsH1(best),
          liquidityUsd: best.liquidityUsd,
          marketCap: best.marketCap,
          fdv: best.fdv,
          priceChangeH1: best.priceChangeH1,
          priceChangeH24: best.priceChangeH24,
        },
        distributionProxy: buildDistributionHeuristics(candidate),
        note:
          "Dexscreener public API does not expose holder-level ownership tables. " +
          "Use holdersCount/holdersSource when available.",
        additionalPairCount: Math.max(pairs.length - 1, 0),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } finally {
      await client.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
