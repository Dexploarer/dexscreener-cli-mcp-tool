import { sendAlerts } from "./alerts.js";
import { type ScanFilters, DEFAULT_CHAINS, defaultScanFilters } from "./config.js";
import type { HotTokenCandidate } from "./models.js";
import {
  type ScanTask,
  type TaskRunRecord,
  StateStore,
  scanPresetToFilters,
  scanTaskToDict,
  taskRunRecordCreate,
  taskRunRecordToDict,
  utcNowIso,
} from "./state.js";

// ---------------------------------------------------------------------------
// We reference the scanner by interface so the module doesn't need a concrete
// import of scanner.ts (which may not exist yet). Any object with an async
// `scan` method satisfies this contract.
// ---------------------------------------------------------------------------

export interface Scanner {
  scan(filters: ScanFilters): Promise<HotTokenCandidate[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_ERROR_LEN = 500;

export function _sanitizeError(msg: string): string {
  let cleaned = msg.replace(/[A-Za-z]:\\[\w\\\-. ]+/g, "<path>");
  cleaned = cleaned.replace(/\/(?:home|tmp|var|usr|etc|Users)\/[\w/\\\-. ]+/g, "<path>");
  return cleaned.slice(0, MAX_ERROR_LEN);
}

function parseIso(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// taskDue / taskFilters
// ---------------------------------------------------------------------------

export function taskDue(
  task: ScanTask,
  now: Date,
  defaultInterval: number,
): boolean {
  const interval = task.intervalSeconds ?? defaultInterval;
  const lastRun = parseIso(task.lastRunAt);
  if (lastRun === null) return true;
  return (now.getTime() - lastRun.getTime()) / 1000 >= interval;
}

export function taskFilters(task: ScanTask, store: StateStore): ScanFilters {
  let filters: ScanFilters = defaultScanFilters([...DEFAULT_CHAINS]);

  if (task.preset) {
    const preset = store.getPreset(task.preset);
    if (preset) {
      filters = scanPresetToFilters(preset);
    }
  }

  if (task.filters) {
    const payload = task.filters;
    if (payload.chains) {
      filters.chains = [...payload.chains];
    }
    if (payload.limit != null) {
      filters.limit = Number(payload.limit);
    }
    if (payload.minLiquidityUsd != null || payload.min_liquidity_usd != null) {
      filters.minLiquidityUsd = Number(payload.minLiquidityUsd ?? payload.min_liquidity_usd);
    }
    if (payload.minVolumeH24Usd != null || payload.min_volume_h24_usd != null) {
      filters.minVolumeH24Usd = Number(payload.minVolumeH24Usd ?? payload.min_volume_h24_usd);
    }
    if (payload.minTxnsH1 != null || payload.min_txns_h1 != null) {
      filters.minTxnsH1 = Number(payload.minTxnsH1 ?? payload.min_txns_h1);
    }
    if (payload.minPriceChangeH1 != null || payload.min_price_change_h1 != null) {
      filters.minPriceChangeH1 = Number(payload.minPriceChangeH1 ?? payload.min_price_change_h1);
    }
  }

  return filters;
}

// ---------------------------------------------------------------------------
// Run recording
// ---------------------------------------------------------------------------

function recordRun(opts: {
  store: StateStore;
  task: ScanTask;
  mode: string;
  startedAt: string;
  elapsedMs: number;
  status: string;
  candidates: HotTokenCandidate[];
  alertResult: Record<string, any>;
  error?: string | null;
}): TaskRunRecord {
  const { store, task, mode, startedAt, elapsedMs, status, candidates, alertResult, error } = opts;
  const top = candidates.length > 0 ? candidates[0] : null;
  const run = taskRunRecordCreate({
    taskId: task.id,
    taskName: task.name,
    mode,
    startedAt,
    finishedAt: utcNowIso(),
    durationMs: elapsedMs,
    status,
    resultCount: candidates.length,
    topChain: top?.pair.chainId ?? null,
    topToken: top?.pair.baseSymbol ?? null,
    topScore: top?.score ?? null,
    alertSent: Boolean(alertResult.sent),
    alertReason: String(alertResult.reason ?? "n/a"),
    error: error ?? null,
  });
  store.appendRun(run);
  return run;
}

// ---------------------------------------------------------------------------
// executeTaskOnce
// ---------------------------------------------------------------------------

export async function executeTaskOnce(opts: {
  store: StateStore;
  scanner: Scanner;
  task: ScanTask;
  mode: string;
  fireAlerts?: boolean;
  markRunning?: boolean;
  blockOnError?: boolean;
}): Promise<Record<string, any>> {
  const {
    store,
    scanner,
    task,
    mode,
    fireAlerts = true,
    markRunning = false,
    blockOnError = false,
  } = opts;

  const startedAt = utcNowIso();
  const t0 = performance.now();
  let candidates: HotTokenCandidate[] = [];
  let alertResult: Record<string, any> = { sent: false, reason: "disabled", channels: {} };

  if (markRunning) {
    store.updateTaskStatus(task.id, "running");
  }

  try {
    const filters = taskFilters(task, store);
    candidates = await scanner.scan(filters);
    store.touchTaskRun(task.id);

    if (fireAlerts) {
      const refreshed = store.getTask(task.id) ?? task;
      alertResult = await sendAlerts(refreshed, candidates);
      if (alertResult.sent) {
        store.touchTaskAlert(task.id);
      }
    }

    if (markRunning) {
      store.updateTaskStatus(task.id, "todo");
    }

    const run = recordRun({
      store,
      task,
      mode,
      startedAt,
      elapsedMs: Math.round(performance.now() - t0),
      status: "ok",
      candidates,
      alertResult,
    });

    return {
      ok: true,
      task: scanTaskToDict(store.getTask(task.id) ?? task),
      filters: {
        chains: [...filters.chains],
        limit: filters.limit,
        minLiquidityUsd: filters.minLiquidityUsd,
        minVolumeH24Usd: filters.minVolumeH24Usd,
        minTxnsH1: filters.minTxnsH1,
        minPriceChangeH1: filters.minPriceChangeH1,
      },
      candidates,
      alert: alertResult,
      run: taskRunRecordToDict(run),
    };
  } catch (exc) {
    if (markRunning) {
      if (blockOnError) {
        store.updateTaskStatus(task.id, "blocked");
      } else {
        store.updateTaskStatus(task.id, "todo");
      }
    }

    const errorMsg = _sanitizeError(String(exc instanceof Error ? exc.message : exc));
    const run = recordRun({
      store,
      task,
      mode,
      startedAt,
      elapsedMs: Math.round(performance.now() - t0),
      status: "error",
      candidates,
      alertResult,
      error: errorMsg,
    });

    return {
      ok: false,
      task: scanTaskToDict(store.getTask(task.id) ?? task),
      filters: null,
      candidates,
      alert: alertResult,
      run: taskRunRecordToDict(run),
      error: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// selectDueTasks
// ---------------------------------------------------------------------------

export function selectDueTasks(opts: {
  store: StateStore;
  taskNameOrId?: string | null;
  allTasks?: boolean;
  defaultIntervalSeconds: number;
}): ScanTask[] {
  const { store, taskNameOrId, allTasks = false, defaultIntervalSeconds } = opts;

  let rows = store.listTasks();

  if (taskNameOrId) {
    const key = taskNameOrId.toLowerCase();
    rows = rows.filter(
      (t) => t.id.toLowerCase() === key || t.name.toLowerCase() === key,
    );
  }

  if (allTasks) {
    rows = rows.filter((t) => t.status !== "blocked");
  }

  const now = new Date();
  const due: ScanTask[] = [];
  for (const row of rows) {
    if (row.status === "blocked" || row.status === "done") continue;
    if (taskDue(row, now, defaultIntervalSeconds)) {
      due.push(row);
    }
  }
  return due;
}
