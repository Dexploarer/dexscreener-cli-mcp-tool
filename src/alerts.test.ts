import { describe, it, expect } from "vitest";
import { validateWebhookUrl, shouldSendAlert } from "./alerts.js";
import { makeTask, makeCandidate } from "./test-helpers.js";

describe("validateWebhookUrl", () => {
  it("accepts valid https URL", () => {
    expect(validateWebhookUrl("https://example.com/webhook")).toBe(
      "https://example.com/webhook",
    );
  });

  it("accepts http for allowed hosts", () => {
    expect(validateWebhookUrl("http://discord.com/webhook")).toBe(
      "http://discord.com/webhook",
    );
    expect(validateWebhookUrl("http://api.telegram.org/bot123/sendMessage")).toBe(
      "http://api.telegram.org/bot123/sendMessage",
    );
  });

  it("rejects http for non-allowed hosts", () => {
    expect(() => validateWebhookUrl("http://evil.com/webhook")).toThrow("https://");
  });

  it("rejects non-URL strings", () => {
    expect(() => validateWebhookUrl("not-a-url")).toThrow("not a valid URL");
  });

  it("rejects ftp scheme", () => {
    expect(() => validateWebhookUrl("ftp://example.com/file")).toThrow("https://");
  });

  it("rejects localhost", () => {
    expect(() => validateWebhookUrl("https://localhost/hook")).toThrow("localhost");
  });

  it("rejects 127.0.0.1", () => {
    expect(() => validateWebhookUrl("https://127.0.0.1/hook")).toThrow("localhost");
  });

  it("rejects URLs with userinfo", () => {
    expect(() => validateWebhookUrl("https://user:pass@example.com")).toThrow("userinfo");
  });

  it("rejects URLs with fragments", () => {
    expect(() => validateWebhookUrl("https://example.com#frag")).toThrow("fragment");
  });

  it("rejects cloud metadata endpoints", () => {
    expect(() => validateWebhookUrl("https://169.254.169.254/latest")).toThrow("metadata");
  });
});

describe("shouldSendAlert", () => {
  const now = new Date("2025-06-01T12:00:00Z");

  it("returns false with no candidates", () => {
    const task = makeTask({ alerts: { webhook_url: "https://example.com" } });
    const { should, reason } = shouldSendAlert(task, [], now);
    expect(should).toBe(false);
    expect(reason).toBe("no-candidates");
  });

  it("returns false when alerts not configured", () => {
    const task = makeTask({ alerts: null });
    const candidates = [makeCandidate()];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("alerts-not-configured");
  });

  it("returns false when no channels configured", () => {
    const task = makeTask({ alerts: { min_score: 10 } });
    const candidates = [makeCandidate({}, { score: 90 })];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("no-channel");
  });

  it("returns false when score below threshold", () => {
    const task = makeTask({
      alerts: { webhook_url: "https://example.com", min_score: 80 },
    });
    const candidates = [makeCandidate({}, { score: 50 })];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("below-threshold");
  });

  it("returns true when all conditions met", () => {
    const task = makeTask({
      alerts: { webhook_url: "https://example.com", min_score: 50 },
    });
    const candidates = [makeCandidate({}, { score: 90 })];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(true);
    expect(reason).toBe("ok");
  });

  it("respects cooldown", () => {
    const task = makeTask({
      alerts: { webhook_url: "https://example.com", min_score: 50, cooldown_seconds: 3600 },
      lastAlertAt: "2025-06-01T11:30:00Z", // 30 min ago
    });
    const candidates = [makeCandidate({}, { score: 90 })];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("cooldown");
  });

  it("sends after cooldown expires", () => {
    const task = makeTask({
      alerts: { webhook_url: "https://example.com", min_score: 50, cooldown_seconds: 900 },
      lastAlertAt: "2025-06-01T11:00:00Z", // 60 min ago
    });
    const candidates = [makeCandidate({}, { score: 90 })];
    const { should } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(true);
  });

  it("applies risk gate: min_liquidity_usd", () => {
    const task = makeTask({
      alerts: {
        webhook_url: "https://example.com",
        min_score: 10,
        min_liquidity_usd: 100_000,
      },
    });
    const candidates = [makeCandidate({ liquidityUsd: 50_000 }, { score: 90 })];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("risk:min-liquidity");
  });

  it("applies risk gate: max_vol_liq_ratio", () => {
    const task = makeTask({
      alerts: {
        webhook_url: "https://example.com",
        min_score: 10,
        max_vol_liq_ratio: 5,
      },
    });
    const candidates = [
      makeCandidate({ volumeH24: 1_000_000, liquidityUsd: 50_000 }, { score: 90 }),
    ];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("risk:vol-liq-ratio");
  });

  it("applies risk gate: blocked_terms", () => {
    const task = makeTask({
      alerts: {
        webhook_url: "https://example.com",
        min_score: 10,
        blocked_terms: ["scam"],
      },
    });
    const candidates = [
      makeCandidate({ baseName: "ScamCoin" }, { score: 90 }),
    ];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("risk:blocked-term");
  });

  it("applies risk gate: blocked_chains", () => {
    const task = makeTask({
      alerts: {
        webhook_url: "https://example.com",
        min_score: 10,
        blocked_chains: ["bsc"],
      },
    });
    const candidates = [
      makeCandidate({ chainId: "bsc" }, { score: 90 }),
    ];
    const { should, reason } = shouldSendAlert(task, candidates, now);
    expect(should).toBe(false);
    expect(reason).toBe("risk:blocked-chain");
  });
});
