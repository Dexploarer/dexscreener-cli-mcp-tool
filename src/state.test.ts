import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  StateStore,
  utcNowIso,
  scanPresetFromFilters,
  scanPresetToFilters,
  scanPresetFromDict,
  scanPresetToDict,
  scanTaskCreate,
  scanTaskFromDict,
  scanTaskToDict,
  taskRunRecordCreate,
  taskRunRecordFromDict,
  taskRunRecordToDict,
} from "./state.js";
import { defaultScanFilters } from "./config.js";

let tmpDir: string;
let store: StateStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dexplorer-test-"));
  store = new StateStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────

describe("utcNowIso", () => {
  it("returns a valid ISO timestamp with +00:00 suffix", () => {
    const ts = utcNowIso();
    expect(ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00/);
  });
});

// ── ScanPreset conversion ────────────────────────────────────────────

describe("scanPresetFromFilters / scanPresetToFilters", () => {
  it("round-trips through filters", () => {
    const filters = defaultScanFilters(["solana", "base"]);
    const preset = scanPresetFromFilters("my-preset", filters);

    expect(preset.name).toBe("my-preset");
    expect(preset.chains).toEqual(["solana", "base"]);

    const restored = scanPresetToFilters(preset);
    expect(restored).toEqual(filters);
  });
});

describe("scanPresetFromDict / scanPresetToDict", () => {
  it("parses from dict with defaults", () => {
    const preset = scanPresetFromDict({ name: "test" });
    expect(preset.name).toBe("test");
    expect(preset.limit).toBe(20);
    expect(preset.minLiquidityUsd).toBe(35_000);
  });

  it("handles snake_case keys", () => {
    const preset = scanPresetFromDict({
      name: "snake",
      min_liquidity_usd: 10_000,
      min_volume_h24_usd: 20_000,
      min_txns_h1: 15,
    });
    expect(preset.minLiquidityUsd).toBe(10_000);
    expect(preset.minVolumeH24Usd).toBe(20_000);
    expect(preset.minTxnsH1).toBe(15);
  });

  it("round-trips through dict", () => {
    const original = scanPresetFromDict({
      name: "roundtrip",
      chains: ["ethereum"],
      limit: 10,
    });
    const dict = scanPresetToDict(original);
    const restored = scanPresetFromDict(dict);
    expect(restored.name).toBe(original.name);
    expect(restored.chains).toEqual(original.chains);
    expect(restored.limit).toBe(original.limit);
  });
});

// ── ScanTask conversion ──────────────────────────────────────────────

describe("scanTaskCreate / scanTaskFromDict / scanTaskToDict", () => {
  it("creates a task with defaults", () => {
    const task = scanTaskCreate({ name: "my-task" });
    expect(task.name).toBe("my-task");
    expect(task.status).toBe("todo");
    expect(task.id).toHaveLength(10);
    expect(task.preset).toBeNull();
  });

  it("round-trips through dict", () => {
    const task = scanTaskCreate({ name: "round", preset: "default", notes: "hi" });
    const dict = scanTaskToDict(task);
    const restored = scanTaskFromDict(dict);
    expect(restored.id).toBe(task.id);
    expect(restored.name).toBe("round");
    expect(restored.preset).toBe("default");
    expect(restored.notes).toBe("hi");
  });

  it("handles snake_case keys in fromDict", () => {
    const task = scanTaskFromDict({
      id: "abc",
      name: "test",
      interval_seconds: 120,
      last_run_at: "2025-01-01T00:00:00+00:00",
    });
    expect(task.intervalSeconds).toBe(120);
    expect(task.lastRunAt).toBe("2025-01-01T00:00:00+00:00");
  });
});

// ── TaskRunRecord ────────────────────────────────────────────────────

describe("taskRunRecordCreate / conversion", () => {
  it("creates a run record with defaults", () => {
    const run = taskRunRecordCreate({
      taskId: "t1",
      taskName: "scan",
      mode: "manual",
      startedAt: "2025-01-01T00:00:00+00:00",
      finishedAt: "2025-01-01T00:00:05+00:00",
      durationMs: 5000,
      status: "ok",
      resultCount: 10,
    });
    expect(run.id).toHaveLength(12);
    expect(run.alertSent).toBe(false);
    expect(run.alertReason).toBe("n/a");
    expect(run.error).toBeNull();
  });

  it("round-trips through dict", () => {
    const run = taskRunRecordCreate({
      taskId: "t1",
      taskName: "scan",
      mode: "auto",
      startedAt: utcNowIso(),
      finishedAt: utcNowIso(),
      durationMs: 1234,
      status: "ok",
      resultCount: 5,
      topChain: "solana",
      topToken: "TEST",
      topScore: 85.5,
    });
    const dict = taskRunRecordToDict(run);
    const restored = taskRunRecordFromDict(dict);
    expect(restored.taskId).toBe("t1");
    expect(restored.topChain).toBe("solana");
    expect(restored.topScore).toBe(85.5);
  });
});

// ── StateStore: Presets ──────────────────────────────────────────────

describe("StateStore presets", () => {
  it("starts empty", () => {
    expect(store.listPresets()).toEqual([]);
  });

  it("saves and retrieves a preset", () => {
    const filters = defaultScanFilters(["solana"]);
    const preset = scanPresetFromFilters("alpha", filters);
    store.savePreset(preset);

    const retrieved = store.getPreset("alpha");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("alpha");
    expect(retrieved!.chains).toEqual(["solana"]);
  });

  it("getPreset is case-insensitive", () => {
    const preset = scanPresetFromFilters("MyPreset", defaultScanFilters());
    store.savePreset(preset);

    expect(store.getPreset("mypreset")).not.toBeNull();
    expect(store.getPreset("MYPRESET")).not.toBeNull();
  });

  it("updates existing preset preserving createdAt", () => {
    const preset1 = scanPresetFromFilters("test", defaultScanFilters());
    store.savePreset(preset1);
    const created = store.getPreset("test")!.createdAt;

    const preset2 = scanPresetFromFilters("test", defaultScanFilters(["base"]));
    store.savePreset(preset2);

    const updated = store.getPreset("test")!;
    expect(updated.createdAt).toBe(created);
    expect(updated.chains).toEqual(["base"]);
  });

  it("deletes a preset", () => {
    const preset = scanPresetFromFilters("deleteme", defaultScanFilters());
    store.savePreset(preset);
    expect(store.deletePreset("deleteme")).toBe(true);
    expect(store.getPreset("deleteme")).toBeNull();
    expect(store.listPresets()).toHaveLength(0);
  });

  it("delete returns false for nonexistent preset", () => {
    expect(store.deletePreset("nope")).toBe(false);
  });

  it("lists presets sorted alphabetically", () => {
    store.savePreset(scanPresetFromFilters("charlie", defaultScanFilters()));
    store.savePreset(scanPresetFromFilters("alpha", defaultScanFilters()));
    store.savePreset(scanPresetFromFilters("bravo", defaultScanFilters()));

    const names = store.listPresets().map((p) => p.name);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });
});

// ── StateStore: Tasks ────────────────────────────────────────────────

describe("StateStore tasks", () => {
  it("starts empty", () => {
    expect(store.listTasks()).toEqual([]);
  });

  it("creates a task", () => {
    const task = store.createTask({ name: "my-task" });
    expect(task.name).toBe("my-task");
    expect(task.status).toBe("todo");
    expect(store.listTasks()).toHaveLength(1);
  });

  it("throws on duplicate task name", () => {
    store.createTask({ name: "dup" });
    expect(() => store.createTask({ name: "dup" })).toThrow("already exists");
  });

  it("gets a task by name or id", () => {
    const task = store.createTask({ name: "findme" });
    expect(store.getTask("findme")).not.toBeNull();
    expect(store.getTask(task.id)).not.toBeNull();
    expect(store.getTask("nope")).toBeNull();
  });

  it("updates task status", () => {
    const task = store.createTask({ name: "status-test" });
    store.updateTaskStatus(task.id, "running");
    expect(store.getTask(task.id)!.status).toBe("running");
  });

  it("touches task run timestamp", () => {
    const task = store.createTask({ name: "run-test" });
    expect(task.lastRunAt).toBeNull();

    store.touchTaskRun(task.id);
    const updated = store.getTask(task.id)!;
    expect(updated.lastRunAt).not.toBeNull();
  });

  it("touches task alert timestamp", () => {
    const task = store.createTask({ name: "alert-test" });
    expect(task.lastAlertAt).toBeNull();

    store.touchTaskAlert(task.id);
    const updated = store.getTask(task.id)!;
    expect(updated.lastAlertAt).not.toBeNull();
  });

  it("updates task properties", () => {
    const task = store.createTask({ name: "update-test" });
    store.updateTask(task.id, { preset: "my-preset", notes: "updated" });

    const updated = store.getTask(task.id)!;
    expect(updated.preset).toBe("my-preset");
    expect(updated.notes).toBe("updated");
  });

  it("deletes a task", () => {
    const task = store.createTask({ name: "delete-test" });
    expect(store.deleteTask(task.id)).toBe(true);
    expect(store.getTask(task.id)).toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(store.deleteTask("nope")).toBe(false);
  });

  it("filters tasks by status", () => {
    store.createTask({ name: "t1" });
    const t2 = store.createTask({ name: "t2" });
    store.updateTaskStatus(t2.id, "done");

    expect(store.listTasks("todo")).toHaveLength(1);
    expect(store.listTasks("done")).toHaveLength(1);
    expect(store.listTasks("running")).toHaveLength(0);
  });
});

// ── StateStore: Runs ─────────────────────────────────────────────────

describe("StateStore runs", () => {
  it("starts empty", () => {
    expect(store.listRuns()).toEqual([]);
  });

  it("appends and lists runs", () => {
    const run = taskRunRecordCreate({
      taskId: "t1",
      taskName: "scan",
      mode: "manual",
      startedAt: utcNowIso(),
      finishedAt: utcNowIso(),
      durationMs: 100,
      status: "ok",
      resultCount: 5,
    });
    store.appendRun(run);
    expect(store.listRuns()).toHaveLength(1);
  });

  it("filters runs by task name", () => {
    const run1 = taskRunRecordCreate({
      taskId: "t1", taskName: "alpha", mode: "m",
      startedAt: utcNowIso(), finishedAt: utcNowIso(),
      durationMs: 0, status: "ok", resultCount: 0,
    });
    const run2 = taskRunRecordCreate({
      taskId: "t2", taskName: "bravo", mode: "m",
      startedAt: utcNowIso(), finishedAt: utcNowIso(),
      durationMs: 0, status: "ok", resultCount: 0,
    });
    store.appendRun(run1);
    store.appendRun(run2);

    expect(store.listRuns("alpha")).toHaveLength(1);
    expect(store.listRuns("bravo")).toHaveLength(1);
    expect(store.listRuns("charlie")).toHaveLength(0);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.appendRun(taskRunRecordCreate({
        taskId: "t1", taskName: "scan", mode: "m",
        startedAt: utcNowIso(), finishedAt: utcNowIso(),
        durationMs: 0, status: "ok", resultCount: 0,
      }));
    }
    expect(store.listRuns(null, 3)).toHaveLength(3);
  });
});

// ── StateStore: Export / Import ──────────────────────────────────────

describe("StateStore export/import", () => {
  it("exports an empty bundle", () => {
    const bundle = store.exportBundle();
    expect(bundle.version).toBe(1);
    expect(bundle.presets).toEqual([]);
    expect(bundle.tasks).toEqual([]);
    expect(bundle.runs).toEqual([]);
  });

  it("round-trips via export/import replace", () => {
    store.savePreset(scanPresetFromFilters("p1", defaultScanFilters()));
    store.createTask({ name: "t1" });

    const bundle = store.exportBundle();

    const store2 = new StateStore(fs.mkdtempSync(path.join(os.tmpdir(), "dex-test2-")));
    const counts = store2.importBundle(bundle, "replace");

    expect(counts.presets).toBe(1);
    expect(counts.tasks).toBe(1);
    expect(store2.getPreset("p1")).not.toBeNull();

    fs.rmSync(store2.baseDir, { recursive: true, force: true });
  });

  it("merge mode combines data", () => {
    store.savePreset(scanPresetFromFilters("existing", defaultScanFilters()));
    const bundle = {
      presets: [{ name: "new-preset", chains: ["solana"], limit: 10 }],
      tasks: [],
      runs: [],
    };
    const counts = store.importBundle(bundle, "merge");
    expect(counts.presets).toBe(2);
    expect(store.getPreset("existing")).not.toBeNull();
    expect(store.getPreset("new-preset")).not.toBeNull();
  });

  it("rejects invalid bundle shapes", () => {
    expect(() => store.importBundle("not-an-object" as any)).toThrow("JSON object");
    expect(() => store.importBundle({ presets: "bad" } as any)).toThrow("arrays");
  });

  it("rejects invalid task status in bundle", () => {
    expect(() =>
      store.importBundle({
        presets: [],
        tasks: [{ id: "1", name: "bad", status: "invalid-status" }],
        runs: [],
      }),
    ).toThrow("invalid task status");
  });

  it("redacts sensitive alert keys in export", () => {
    const task = store.createTask({
      name: "secret",
      alerts: {
        webhook_url: "https://example.com/hook",
        discord_webhook_url: "https://discord.com/hook",
        min_score: 50,
      },
    });

    const bundle = store.exportBundle();
    const exported = bundle.tasks[0];
    expect(exported.alerts.webhook_url).toBeUndefined();
    expect(exported.alerts.discord_webhook_url).toBeUndefined();
    expect(exported.alerts._redacted).toBe(true);
    expect(exported.alerts.min_score).toBe(50);
  });
});
