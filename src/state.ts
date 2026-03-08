import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type ScanFilters, DEFAULT_CHAINS, defaultScanFilters } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type TaskStatus = "todo" | "running" | "done" | "blocked";

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  "todo",
  "running",
  "done",
  "blocked",
]);

const MAX_IMPORTED_RUNS = 5_000;

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function makeId(length: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

// ---------------------------------------------------------------------------
// ScanPreset
// ---------------------------------------------------------------------------

export interface ScanPreset {
  name: string;
  chains: string[];
  limit: number;
  minLiquidityUsd: number;
  minVolumeH24Usd: number;
  minTxnsH1: number;
  minPriceChangeH1: number;
  createdAt: string;
  updatedAt: string;
}

export function scanPresetFromFilters(name: string, filters: ScanFilters): ScanPreset {
  const now = utcNowIso();
  return {
    name,
    chains: [...filters.chains],
    limit: filters.limit,
    minLiquidityUsd: filters.minLiquidityUsd,
    minVolumeH24Usd: filters.minVolumeH24Usd,
    minTxnsH1: filters.minTxnsH1,
    minPriceChangeH1: filters.minPriceChangeH1,
    createdAt: now,
    updatedAt: now,
  };
}

export function scanPresetToFilters(preset: ScanPreset): ScanFilters {
  return {
    chains: [...preset.chains],
    limit: preset.limit,
    minLiquidityUsd: preset.minLiquidityUsd,
    minVolumeH24Usd: preset.minVolumeH24Usd,
    minTxnsH1: preset.minTxnsH1,
    minPriceChangeH1: preset.minPriceChangeH1,
  };
}

export function scanPresetFromDict(payload: Record<string, any>): ScanPreset {
  return {
    name: String(payload.name),
    chains: Array.isArray(payload.chains) ? payload.chains : [...DEFAULT_CHAINS],
    limit: Number(payload.limit ?? 20),
    minLiquidityUsd: Number(payload.minLiquidityUsd ?? payload.min_liquidity_usd ?? 35_000),
    minVolumeH24Usd: Number(payload.minVolumeH24Usd ?? payload.min_volume_h24_usd ?? 90_000),
    minTxnsH1: Number(payload.minTxnsH1 ?? payload.min_txns_h1 ?? 80),
    minPriceChangeH1: Number(payload.minPriceChangeH1 ?? payload.min_price_change_h1 ?? 0),
    createdAt: String(payload.createdAt ?? payload.created_at ?? utcNowIso()),
    updatedAt: String(payload.updatedAt ?? payload.updated_at ?? utcNowIso()),
  };
}

export function scanPresetToDict(preset: ScanPreset): Record<string, any> {
  return {
    name: preset.name,
    chains: [...preset.chains],
    limit: preset.limit,
    minLiquidityUsd: preset.minLiquidityUsd,
    minVolumeH24Usd: preset.minVolumeH24Usd,
    minTxnsH1: preset.minTxnsH1,
    minPriceChangeH1: preset.minPriceChangeH1,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// ScanTask
// ---------------------------------------------------------------------------

export interface ScanTask {
  id: string;
  name: string;
  preset: string | null;
  filters: Record<string, any> | null;
  intervalSeconds: number | null;
  alerts: Record<string, any> | null;
  status: TaskStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastAlertAt: string | null;
}

export function scanTaskCreate(opts: {
  name: string;
  preset?: string | null;
  filters?: Record<string, any> | null;
  intervalSeconds?: number | null;
  alerts?: Record<string, any> | null;
  status?: TaskStatus;
  notes?: string;
}): ScanTask {
  const now = utcNowIso();
  return {
    id: makeId(10),
    name: opts.name,
    preset: opts.preset ?? null,
    filters: opts.filters ?? null,
    intervalSeconds: opts.intervalSeconds ?? null,
    alerts: opts.alerts ?? null,
    status: opts.status ?? "todo",
    notes: opts.notes ?? "",
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastAlertAt: null,
  };
}

export function scanTaskFromDict(payload: Record<string, any>): ScanTask {
  return {
    id: String(payload.id),
    name: String(payload.name),
    preset: payload.preset ?? null,
    filters: payload.filters ?? null,
    intervalSeconds: payload.intervalSeconds ?? payload.interval_seconds ?? null,
    alerts: payload.alerts ?? null,
    status: (String(payload.status ?? "todo") as TaskStatus),
    notes: String(payload.notes ?? ""),
    createdAt: String(payload.createdAt ?? payload.created_at ?? utcNowIso()),
    updatedAt: String(payload.updatedAt ?? payload.updated_at ?? utcNowIso()),
    lastRunAt: payload.lastRunAt ?? payload.last_run_at ?? null,
    lastAlertAt: payload.lastAlertAt ?? payload.last_alert_at ?? null,
  };
}

export function scanTaskToDict(task: ScanTask): Record<string, any> {
  return { ...task };
}

// ---------------------------------------------------------------------------
// TaskRunRecord
// ---------------------------------------------------------------------------

export interface TaskRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  resultCount: number;
  topChain: string | null;
  topToken: string | null;
  topScore: number | null;
  alertSent: boolean;
  alertReason: string;
  error: string | null;
}

export function taskRunRecordCreate(opts: {
  taskId: string;
  taskName: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: string;
  resultCount: number;
  topChain?: string | null;
  topToken?: string | null;
  topScore?: number | null;
  alertSent?: boolean;
  alertReason?: string;
  error?: string | null;
}): TaskRunRecord {
  return {
    id: makeId(12),
    taskId: opts.taskId,
    taskName: opts.taskName,
    mode: opts.mode,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    durationMs: opts.durationMs,
    status: opts.status,
    resultCount: opts.resultCount,
    topChain: opts.topChain ?? null,
    topToken: opts.topToken ?? null,
    topScore: opts.topScore ?? null,
    alertSent: opts.alertSent ?? false,
    alertReason: opts.alertReason ?? "n/a",
    error: opts.error ?? null,
  };
}

export function taskRunRecordFromDict(payload: Record<string, any>): TaskRunRecord {
  return {
    id: String(payload.id),
    taskId: String(payload.taskId ?? payload.task_id ?? ""),
    taskName: String(payload.taskName ?? payload.task_name ?? ""),
    mode: String(payload.mode ?? "manual"),
    startedAt: String(payload.startedAt ?? payload.started_at ?? utcNowIso()),
    finishedAt: String(payload.finishedAt ?? payload.finished_at ?? utcNowIso()),
    durationMs: Number(payload.durationMs ?? payload.duration_ms ?? 0),
    status: String(payload.status ?? "ok"),
    resultCount: Number(payload.resultCount ?? payload.result_count ?? 0),
    topChain: payload.topChain ?? payload.top_chain ?? null,
    topToken: payload.topToken ?? payload.top_token ?? null,
    topScore: payload.topScore ?? payload.top_score ?? null,
    alertSent: Boolean(payload.alertSent ?? payload.alert_sent ?? false),
    alertReason: String(payload.alertReason ?? payload.alert_reason ?? "n/a"),
    error: payload.error ?? null,
  };
}

export function taskRunRecordToDict(record: TaskRunRecord): Record<string, any> {
  return { ...record };
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

const REDACTED_ALERT_KEYS: ReadonlySet<string> = new Set([
  "webhook_url",
  "discord_webhook_url",
  "telegram_bot_token",
  "telegram_chat_id",
]);

function redactTask(taskDict: Record<string, any>): Record<string, any> {
  const alerts = taskDict.alerts;
  if (!alerts || typeof alerts !== "object") return taskDict;

  const cleaned: Record<string, any> = {};
  let hadRedacted = false;
  for (const [k, v] of Object.entries(alerts)) {
    if (REDACTED_ALERT_KEYS.has(k)) {
      hadRedacted = true;
    } else {
      cleaned[k] = v;
    }
  }
  if (hadRedacted) {
    cleaned._redacted = true;
  }
  return { ...taskDict, alerts: cleaned };
}

export class StateStore {
  readonly baseDir: string;
  private readonly presetsFile: string;
  private readonly tasksFile: string;
  private readonly runsFile: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".dexplorer-cli");
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.presetsFile = path.join(this.baseDir, "presets.json");
    this.tasksFile = path.join(this.baseDir, "tasks.json");
    this.runsFile = path.join(this.baseDir, "runs.json");
  }

  // ── File I/O ────────────────────────────────────────────────────

  private loadJson(filePath: string): Record<string, any> {
    if (!fs.existsSync(filePath)) return {};
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf-8").trim();
    } catch {
      return {};
    }
    if (!text) return {};
    try {
      const payload = JSON.parse(text);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
      return payload;
    } catch {
      return {};
    }
  }

  private saveJson(filePath: string, payload: Record<string, any>): void {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  // ── Presets ─────────────────────────────────────────────────────

  listPresets(): ScanPreset[] {
    const data = this.loadJson(this.presetsFile);
    const rows = ((data.presets ?? []) as Record<string, any>[]).map(scanPresetFromDict);
    rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return rows;
  }

  getPreset(name: string): ScanPreset | null {
    const wanted = name.trim().toLowerCase();
    for (const preset of this.listPresets()) {
      if (preset.name.toLowerCase() === wanted) return preset;
    }
    return null;
  }

  savePreset(preset: ScanPreset): ScanPreset {
    const rows = this.listPresets();
    const existing = this.getPreset(preset.name);
    if (existing) {
      preset.createdAt = existing.createdAt;
    }
    preset.updatedAt = utcNowIso();
    const newRows = rows.filter(
      (p) => p.name.toLowerCase() !== preset.name.toLowerCase(),
    );
    newRows.push(preset);
    newRows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    this.saveJson(this.presetsFile, { presets: newRows.map(scanPresetToDict) });
    return preset;
  }

  deletePreset(name: string): boolean {
    const rows = this.listPresets();
    const newRows = rows.filter(
      (p) => p.name.toLowerCase() !== name.trim().toLowerCase(),
    );
    if (newRows.length === rows.length) return false;
    this.saveJson(this.presetsFile, { presets: newRows.map(scanPresetToDict) });
    return true;
  }

  // ── Tasks ───────────────────────────────────────────────────────

  listTasks(status?: TaskStatus | null): ScanTask[] {
    const data = this.loadJson(this.tasksFile);
    let rows = ((data.tasks ?? []) as Record<string, any>[]).map(scanTaskFromDict);
    if (status) {
      rows = rows.filter((t) => t.status === status);
    }
    rows.sort((a, b) => {
      const cmp = a.status.localeCompare(b.status);
      if (cmp !== 0) return cmp;
      return a.updatedAt.localeCompare(b.updatedAt);
    });
    return rows;
  }

  getTask(nameOrId: string): ScanTask | null {
    const key = nameOrId.trim().toLowerCase();
    for (const task of this.listTasks()) {
      if (task.id.toLowerCase() === key || task.name.toLowerCase() === key) {
        return task;
      }
    }
    return null;
  }

  createTask(opts: {
    name: string;
    preset?: string | null;
    filters?: Record<string, any> | null;
    intervalSeconds?: number | null;
    alerts?: Record<string, any> | null;
    notes?: string;
  }): ScanTask {
    const rows = this.listTasks();
    if (rows.some((t) => t.name.toLowerCase() === opts.name.toLowerCase())) {
      throw new Error(`Task '${opts.name}' already exists`);
    }
    const task = scanTaskCreate(opts);
    rows.push(task);
    this.saveJson(this.tasksFile, { tasks: rows.map(scanTaskToDict) });
    return task;
  }

  updateTaskStatus(nameOrId: string, status: TaskStatus): ScanTask {
    const rows = this.listTasks();
    let updated: ScanTask | null = null;
    for (const task of rows) {
      if (
        task.id.toLowerCase() === nameOrId.toLowerCase() ||
        task.name.toLowerCase() === nameOrId.toLowerCase()
      ) {
        task.status = status;
        task.updatedAt = utcNowIso();
        updated = task;
        break;
      }
    }
    if (!updated) throw new Error(`Task '${nameOrId}' not found`);
    this.saveJson(this.tasksFile, { tasks: rows.map(scanTaskToDict) });
    return updated;
  }

  touchTaskRun(nameOrId: string): ScanTask {
    const rows = this.listTasks();
    let updated: ScanTask | null = null;
    for (const task of rows) {
      if (
        task.id.toLowerCase() === nameOrId.toLowerCase() ||
        task.name.toLowerCase() === nameOrId.toLowerCase()
      ) {
        const now = utcNowIso();
        task.lastRunAt = now;
        task.updatedAt = now;
        updated = task;
        break;
      }
    }
    if (!updated) throw new Error(`Task '${nameOrId}' not found`);
    this.saveJson(this.tasksFile, { tasks: rows.map(scanTaskToDict) });
    return updated;
  }

  touchTaskAlert(nameOrId: string): ScanTask {
    const rows = this.listTasks();
    let updated: ScanTask | null = null;
    for (const task of rows) {
      if (
        task.id.toLowerCase() === nameOrId.toLowerCase() ||
        task.name.toLowerCase() === nameOrId.toLowerCase()
      ) {
        const now = utcNowIso();
        task.lastAlertAt = now;
        task.updatedAt = now;
        updated = task;
        break;
      }
    }
    if (!updated) throw new Error(`Task '${nameOrId}' not found`);
    this.saveJson(this.tasksFile, { tasks: rows.map(scanTaskToDict) });
    return updated;
  }

  updateTask(
    nameOrId: string,
    opts: {
      preset?: string | null;
      filters?: Record<string, any> | null;
      intervalSeconds?: number | null;
      alerts?: Record<string, any> | null;
      notes?: string | null;
    },
  ): ScanTask {
    const rows = this.listTasks();
    let updated: ScanTask | null = null;
    for (const task of rows) {
      if (
        task.id.toLowerCase() === nameOrId.toLowerCase() ||
        task.name.toLowerCase() === nameOrId.toLowerCase()
      ) {
        task.preset = opts.preset ?? null;
        task.filters = opts.filters ?? null;
        task.intervalSeconds = opts.intervalSeconds ?? null;
        task.alerts = opts.alerts ?? null;
        if (opts.notes != null) {
          task.notes = opts.notes;
        }
        task.updatedAt = utcNowIso();
        updated = task;
        break;
      }
    }
    if (!updated) throw new Error(`Task '${nameOrId}' not found`);
    this.saveJson(this.tasksFile, { tasks: rows.map(scanTaskToDict) });
    return updated;
  }

  deleteTask(nameOrId: string): boolean {
    const rows = this.listTasks();
    const key = nameOrId.trim().toLowerCase();
    const newRows = rows.filter(
      (t) => t.id.toLowerCase() !== key && t.name.toLowerCase() !== key,
    );
    if (newRows.length === rows.length) return false;
    this.saveJson(this.tasksFile, { tasks: newRows.map(scanTaskToDict) });
    return true;
  }

  // ── Runs ────────────────────────────────────────────────────────

  listRuns(task?: string | null, limit: number = 200): TaskRunRecord[] {
    const data = this.loadJson(this.runsFile);
    let rows = ((data.runs ?? []) as Record<string, any>[]).map(taskRunRecordFromDict);
    if (task) {
      const key = task.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.taskId.toLowerCase() === key || r.taskName.toLowerCase() === key,
      );
    }
    rows.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    return rows.slice(0, limit);
  }

  appendRun(run: TaskRunRecord): TaskRunRecord {
    const rows = this.listRuns(null, 10_000);
    rows.push(run);
    rows.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
    const bounded = rows.slice(-5000);
    this.saveJson(this.runsFile, { runs: bounded.map(taskRunRecordToDict) });
    return run;
  }

  // ── Export / Import ─────────────────────────────────────────────

  exportBundle(): Record<string, any> {
    return {
      version: 1,
      exportedAt: utcNowIso(),
      presets: this.listPresets().map(scanPresetToDict),
      tasks: this.listTasks().map((t) => redactTask(scanTaskToDict(t))),
      runs: this.listRuns(null, 50_000).map(taskRunRecordToDict),
    };
  }

  importBundle(
    bundle: Record<string, any>,
    mode: "merge" | "replace" = "merge",
  ): { presets: number; tasks: number; runs: number } {
    if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
      throw new Error("Bundle must be a JSON object");
    }

    const presetsRaw = bundle.presets ?? [];
    const tasksRaw = bundle.tasks ?? [];
    const runsRaw = bundle.runs ?? [];

    if (!Array.isArray(presetsRaw) || !Array.isArray(tasksRaw) || !Array.isArray(runsRaw)) {
      throw new Error("Bundle presets/tasks/runs must be arrays");
    }
    if (runsRaw.length > MAX_IMPORTED_RUNS) {
      throw new Error(`Bundle exceeds max ${MAX_IMPORTED_RUNS} runs`);
    }
    if (!presetsRaw.every((item: any) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      throw new Error("Bundle presets must contain only objects");
    }
    if (!tasksRaw.every((item: any) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      throw new Error("Bundle tasks must contain only objects");
    }
    if (!runsRaw.every((item: any) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      throw new Error("Bundle runs must contain only objects");
    }
    if (tasksRaw.some((item: any) => !VALID_TASK_STATUSES.has(String(item.status ?? "todo")))) {
      throw new Error("Bundle contains invalid task status");
    }

    const presetsIn = presetsRaw.map(scanPresetFromDict);
    const tasksIn = tasksRaw.map(scanTaskFromDict);
    const runsIn = runsRaw.map(taskRunRecordFromDict);

    if (mode === "replace") {
      this.saveJson(this.presetsFile, { presets: presetsIn.map(scanPresetToDict) });
      this.saveJson(this.tasksFile, { tasks: tasksIn.map(scanTaskToDict) });
      this.saveJson(this.runsFile, { runs: runsIn.map(taskRunRecordToDict) });
      return { presets: presetsIn.length, tasks: tasksIn.length, runs: runsIn.length };
    }

    // merge mode
    const presetMap = new Map<string, ScanPreset>();
    for (const p of this.listPresets()) presetMap.set(p.name.toLowerCase(), p);
    for (const p of presetsIn) presetMap.set(p.name.toLowerCase(), p);
    const mergedPresets = [...presetMap.values()].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
    this.saveJson(this.presetsFile, { presets: mergedPresets.map(scanPresetToDict) });

    const taskMap = new Map<string, ScanTask>();
    for (const t of this.listTasks()) taskMap.set(t.name.toLowerCase(), t);
    for (const t of tasksIn) taskMap.set(t.name.toLowerCase(), t);
    const mergedTasks = [...taskMap.values()];
    this.saveJson(this.tasksFile, { tasks: mergedTasks.map(scanTaskToDict) });

    const runMap = new Map<string, TaskRunRecord>();
    for (const r of this.listRuns(null, 50_000)) runMap.set(r.id, r);
    for (const r of runsIn) runMap.set(r.id, r);
    const mergedRuns = [...runMap.values()]
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
      .slice(-5000);
    this.saveJson(this.runsFile, { runs: mergedRuns.map(taskRunRecordToDict) });

    return { presets: mergedPresets.length, tasks: mergedTasks.length, runs: mergedRuns.length };
  }
}
