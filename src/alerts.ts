import { lookup } from "node:dns/promises";

import type { HotTokenCandidate } from "./models.js";
import type { ScanTask } from "./state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
  "api.telegram.org",
]);

const MAX_CHANNEL_ERROR_LEN = 240;
const URL_ERROR_RE = /https?:\/\/\S+/g;
const TG_TOKEN_RE = /bot[0-9A-Za-z:_-]+/g;

// ---------------------------------------------------------------------------
// SSRF protection helpers
// ---------------------------------------------------------------------------

interface ResolvedWebhookTarget {
  connectUrl: string;
  hostHeader: string;
  sniHostname: string | null;
}

function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 private/reserved/loopback/link-local ranges
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 0) return true;
    if (parts[0] >= 224) return true; // multicast + reserved
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 private/reserved/loopback
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

async function resolvePublicAddresses(
  hostname: string,
  allowUnresolved: boolean,
): Promise<string[]> {
  let results: { address: string }[];
  try {
    results = await lookup(hostname, { all: true });
  } catch {
    if (allowUnresolved) return [];
    throw new Error("Webhook hostname did not resolve");
  }

  const addresses: string[] = [];
  for (const { address } of results) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`Webhook URL resolves to private/reserved address: ${address}`);
    }
    addresses.push(address);
  }
  return addresses;
}

async function buildDeliveryTarget(url: string): Promise<ResolvedWebhookTarget> {
  validateWebhookUrl(url);
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const addresses = await resolvePublicAddresses(hostname, false);
  if (addresses.length === 0) {
    throw new Error("Webhook hostname did not resolve");
  }

  let connectHost = addresses[0];
  if (connectHost.includes(":")) {
    connectHost = `[${connectHost}]`;
  }

  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  let netloc = connectHost;
  if (parsed.port && parsed.port !== defaultPort) {
    netloc = `${netloc}:${parsed.port}`;
  }

  let hostHeader = hostname;
  if (parsed.port && parsed.port !== defaultPort) {
    hostHeader = `${hostHeader}:${parsed.port}`;
  }

  const connectUrl = `${parsed.protocol}//${netloc}${parsed.pathname}${parsed.search}`;
  return {
    connectUrl,
    hostHeader,
    sniHostname: parsed.protocol === "https:" ? hostname : null,
  };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export function validateWebhookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Webhook URL is not a valid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Webhook URL must use https:// scheme, got ${parsed.protocol.replace(":", "://")}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error("Webhook URL has no hostname");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Webhook URL must not include userinfo");
  }
  if (parsed.hash) {
    throw new Error("Webhook URL must not include fragments");
  }

  if (parsed.protocol === "http:" && !ALLOWED_WEBHOOK_HOSTS.has(hostname)) {
    throw new Error(
      "Webhook URL must use https:// (http only allowed for discord.com, api.telegram.org)",
    );
  }

  const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
  if (blockedHosts.has(hostname)) {
    throw new Error("Webhook URL must not point to localhost");
  }

  const metadataIps = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);
  if (metadataIps.has(hostname)) {
    throw new Error("Webhook URL must not point to cloud metadata endpoints");
  }

  // Note: DNS resolution check is async; done separately in buildDeliveryTarget.
  return url;
}

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

function sanitizeChannelError(exc: unknown): string {
  const message = exc instanceof Error ? exc.message : String(exc);
  const name = exc instanceof Error ? exc.constructor.name : "Error";
  let cleaned = message.replace(URL_ERROR_RE, "<url>");
  cleaned = cleaned.replace(TG_TOKEN_RE, "bot<redacted>");
  cleaned = cleaned.slice(0, MAX_CHANNEL_ERROR_LEN);
  return `${name}: ${cleaned}`;
}

// ---------------------------------------------------------------------------
// Candidate formatting
// ---------------------------------------------------------------------------

function candidateLine(candidate: HotTokenCandidate): string {
  const p = candidate.pair;
  return (
    `${p.chainId}:${p.baseSymbol} score=${candidate.score.toFixed(1)} ` +
    `1h=${p.priceChangeH1 >= 0 ? "+" : ""}${p.priceChangeH1.toFixed(2)}% vol24=$${p.volumeH24.toLocaleString("en-US", { maximumFractionDigits: 0 })} ` +
    `liq=$${p.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${p.pairUrl}`
  );
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function safeSubstitute(template: string, context: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`$${key}`, value);
  }
  return result;
}

function asList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [String(value).trim()];
}

function hasChannels(alerts: Record<string, any>): boolean {
  return !!(
    alerts.webhook_url ||
    alerts.discord_webhook_url ||
    (alerts.telegram_bot_token && alerts.telegram_chat_id)
  );
}

function alertContext(
  task: ScanTask,
  candidates: HotTokenCandidate[],
  now: Date,
  topN: number,
): Record<string, string> {
  const top = candidates.length > 0 ? candidates[0] : null;
  const topLines = candidates.length > 0
    ? candidates.slice(0, topN).map(candidateLine).join("\n")
    : "No candidates.";
  const topChain = top ? top.pair.chainId : "n/a";
  const topToken = top ? top.pair.baseSymbol : "n/a";
  const topScore = top ? top.score.toFixed(2) : "0.00";
  const topH1 = top
    ? `${top.pair.priceChangeH1 >= 0 ? "+" : ""}${top.pair.priceChangeH1.toFixed(2)}%`
    : "0.00%";
  const topVol = top
    ? `$${top.pair.volumeH24.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "$0";
  const topLiq = top
    ? `$${top.pair.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "$0";
  const topUrl = top ? top.pair.pairUrl : "";

  return {
    timestamp: now.toISOString(),
    task_name: task.name,
    task_id: task.id,
    result_count: String(candidates.length),
    top_chain: topChain,
    top_token: topToken,
    top_score: topScore,
    top_h1: topH1,
    top_vol: topVol,
    top_liq: topLiq,
    top_url: topUrl,
    top_lines: topLines,
  };
}

function renderMessage(
  task: ScanTask,
  alerts: Record<string, any>,
  candidates: HotTokenCandidate[],
  now: Date,
): string {
  const topN = Number(alerts.top_n ?? 3);
  const context = alertContext(task, candidates, now, topN);
  const defaultTemplate =
    "[$task_name] Hot token alert\n" +
    "Top: $top_chain:$top_token score=$top_score 1h=$top_h1 vol24=$top_vol liq=$top_liq\n" +
    "$top_url\n" +
    "$top_lines";
  let raw = String(alerts.template ?? "");
  // Migrate legacy {var} templates to $var syntax.
  if (raw.includes("{")) {
    for (const key of Object.keys(context)) {
      raw = raw.replaceAll(`{${key}}`, `$${key}`);
    }
  }
  const template = raw.trim() ? raw : defaultTemplate;
  return safeSubstitute(template, context);
}

// ---------------------------------------------------------------------------
// Risk gate
// ---------------------------------------------------------------------------

function riskGate(
  alerts: Record<string, any>,
  candidates: HotTokenCandidate[],
): { passes: boolean; reason: string } {
  if (candidates.length === 0) return { passes: false, reason: "no-candidates" };
  const top = candidates[0];

  const minLiq = Number(alerts.min_liquidity_usd ?? 0) || 0;
  if (minLiq > 0 && top.pair.liquidityUsd < minLiq) {
    return { passes: false, reason: "risk:min-liquidity" };
  }

  const maxRatio = Number(alerts.max_vol_liq_ratio ?? 0) || 0;
  if (maxRatio > 0) {
    const ratio = top.pair.volumeH24 / Math.max(top.pair.liquidityUsd, 1);
    if (ratio > maxRatio) {
      return { passes: false, reason: "risk:vol-liq-ratio" };
    }
  }

  const blockedTerms = asList(alerts.blocked_terms).map((t) => t.toLowerCase());
  if (blockedTerms.length > 0) {
    const hay = `${top.pair.baseSymbol} ${top.pair.baseName}`.toLowerCase();
    if (blockedTerms.some((term) => hay.includes(term))) {
      return { passes: false, reason: "risk:blocked-term" };
    }
  }

  const blockedChains = new Set(asList(alerts.blocked_chains).map((c) => c.toLowerCase()));
  if (blockedChains.size > 0 && blockedChains.has(top.pair.chainId.toLowerCase())) {
    return { passes: false, reason: "risk:blocked-chain" };
  }

  return { passes: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// shouldSendAlert
// ---------------------------------------------------------------------------

function parseIso(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

export function shouldSendAlert(
  task: ScanTask,
  candidates: HotTokenCandidate[],
  now: Date,
): { should: boolean; reason: string } {
  if (candidates.length === 0) return { should: false, reason: "no-candidates" };
  if (!task.alerts) return { should: false, reason: "alerts-not-configured" };

  const alerts = task.alerts;
  if (!hasChannels(alerts)) return { should: false, reason: "no-channel" };

  const minScore = Number(alerts.min_score ?? 75);
  const cooldown = Number(alerts.cooldown_seconds ?? 900);
  const top = candidates[0];

  if (top.score < minScore) return { should: false, reason: "below-threshold" };

  const lastAlert = parseIso(task.lastAlertAt);
  if (lastAlert) {
    const elapsed = (now.getTime() - lastAlert.getTime()) / 1000;
    if (elapsed < cooldown) return { should: false, reason: "cooldown" };
  }

  const { passes, reason: riskReason } = riskGate(alerts, candidates);
  if (!passes) return { should: false, reason: riskReason };

  return { should: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// HTTP posting with SSRF pinning
// ---------------------------------------------------------------------------

async function postJson(
  url: string,
  payload: Record<string, any>,
  timeoutMs: number = 10_000,
): Promise<Response> {
  const target = await buildDeliveryTarget(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target.connectUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: target.hostHeader,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Channel dispatch
// ---------------------------------------------------------------------------

async function dispatchChannels(opts: {
  task: ScanTask;
  alerts: Record<string, any>;
  candidates: HotTokenCandidate[];
  message: string;
  now: Date;
  isTest: boolean;
}): Promise<Record<string, any>> {
  const { task, alerts, candidates, message, now, isTest } = opts;
  const channels: Record<string, Record<string, any>> = {};
  const top = candidates.length > 0 ? candidates[0] : null;
  let webhookExtra = alerts.webhook_extra;
  if (typeof webhookExtra !== "object" || webhookExtra === null) {
    webhookExtra = {};
  }

  // Generic webhook
  const webhook = alerts.webhook_url;
  if (webhook) {
    try {
      const resp = await postJson(webhook, {
        event: "dexplorer.task.alert",
        test: isTest,
        task: { id: task.id, name: task.name },
        timestamp: now.toISOString(),
        message,
        top: {
          chainId: top?.pair.chainId ?? null,
          token: top?.pair.baseSymbol ?? null,
          score: top?.score ?? null,
          priceChangeH1: top?.pair.priceChangeH1 ?? null,
          volumeH24: top?.pair.volumeH24 ?? null,
          liquidityUsd: top?.pair.liquidityUsd ?? null,
          pairUrl: top?.pair.pairUrl ?? null,
        },
        results: candidates.slice(0, 5).map((c) => ({
          chainId: c.pair.chainId,
          token: c.pair.baseSymbol,
          tokenName: c.pair.baseName,
          score: c.score,
          priceChangeH1: c.pair.priceChangeH1,
          volumeH24: c.pair.volumeH24,
          liquidityUsd: c.pair.liquidityUsd,
          pairUrl: c.pair.pairUrl,
        })),
        extra: webhookExtra,
      });
      channels.webhook = { ok: resp.ok, status: resp.status };
    } catch (exc) {
      channels.webhook = { ok: false, error: sanitizeChannelError(exc) };
    }
  }

  // Discord
  const discord = alerts.discord_webhook_url;
  if (discord) {
    try {
      const fields = candidates.slice(0, 3).map((c) => ({
        name: `${c.pair.chainId}:${c.pair.baseSymbol} (${c.score.toFixed(1)})`,
        value:
          `1h ${c.pair.priceChangeH1 >= 0 ? "+" : ""}${c.pair.priceChangeH1.toFixed(2)}% | ` +
          `Vol24 $${c.pair.volumeH24.toLocaleString("en-US", { maximumFractionDigits: 0 })} | ` +
          `Liq $${c.pair.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}\n${c.pair.pairUrl}`,
        inline: false,
      }));
      const resp = await postJson(discord, {
        content: `[${isTest ? "TEST" : "ALERT"}] ${task.name}`,
        embeds: [
          {
            title: "Dexplorer Signal",
            description: message.slice(0, 3000),
            color: isTest ? 3447003 : 3066993,
            fields,
            timestamp: now.toISOString(),
          },
        ],
      });
      channels.discord = { ok: resp.ok, status: resp.status };
    } catch (exc) {
      channels.discord = { ok: false, error: sanitizeChannelError(exc) };
    }
  }

  // Telegram
  const tgToken = alerts.telegram_bot_token;
  const tgChat = alerts.telegram_chat_id;
  if (tgToken && tgChat) {
    try {
      if (!/^[0-9A-Za-z:_-]+$/.test(String(tgToken))) {
        throw new Error("Telegram bot token contains invalid characters");
      }
      const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
      const resp = await postJson(tgUrl, {
        chat_id: String(tgChat),
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      channels.telegram = { ok: resp.ok, status: resp.status };
    } catch (exc) {
      channels.telegram = { ok: false, error: sanitizeChannelError(exc) };
    }
  }

  const sent = Object.values(channels).some((v) => v.ok);
  return {
    sent,
    reason: sent ? "ok" : "all-channels-failed",
    channels,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendAlerts(
  task: ScanTask,
  candidates: HotTokenCandidate[],
): Promise<Record<string, any>> {
  const now = new Date();
  const { should, reason } = shouldSendAlert(task, candidates, now);
  if (!should) {
    return { sent: false, reason, channels: {} };
  }

  const alerts = task.alerts ?? {};
  const message = renderMessage(task, alerts, candidates, now);
  return dispatchChannels({
    task,
    alerts,
    candidates,
    message,
    now,
    isTest: false,
  });
}

export async function sendTestAlert(
  task: ScanTask,
  candidates?: HotTokenCandidate[],
): Promise<Record<string, any>> {
  const now = new Date();
  const alerts = task.alerts ?? {};
  if (!task.alerts) {
    return { sent: false, reason: "alerts-not-configured", channels: {} };
  }
  if (!hasChannels(alerts)) {
    return { sent: false, reason: "no-channel", channels: {} };
  }
  const cands = candidates ?? [];
  const message = `[TEST] ${task.name}\n` + renderMessage(task, alerts, cands, now);
  return dispatchChannels({
    task,
    alerts,
    candidates: cands,
    message,
    now,
    isTest: true,
  });
}
