import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { taskDue, taskFilters, selectDueTasks, _sanitizeError } from "./task-runner.js";
import { StateStore, scanPresetFromFilters } from "./state.js";
import { defaultScanFilters } from "./config.js";
import { makeTask } from "./test-helpers.js";

describe("_sanitizeError", () => {
  it("redacts unix paths", () => {
    const result = _sanitizeError("Error reading /home/user/.config/file.json");
    expect(result).toContain("<path>");
    expect(result).not.toContain("/home/user");
  });

  it("redacts windows paths", () => {
    const result = _sanitizeError("Error at C:\\Users\\bob\\file.txt");
    expect(result).toContain("<path>");
    expect(result).not.toContain("C:\\Users");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(1000);
    const result = _sanitizeError(long);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("passes through short clean messages", () => {
    const result = _sanitizeError("Connection timeout");
    expect(result).toBe("Connection timeout");
  });
});

describe("taskDue", () => {
  const now = new Date("2025-06-01T12:00:00Z");

  it("returns true when never run", () => {
    const task = makeTask({ lastRunAt: null });
    expect(taskDue(task, now, 300)).toBe(true);
  });

  it("returns true when interval elapsed", () => {
    const task = makeTask({
      lastRunAt: "2025-06-01T11:50:00Z", // 10 min ago
      intervalSeconds: 300, // 5 min
    });
    expect(taskDue(task, now, 600)).toBe(true);
  });

  it("returns false when within interval", () => {
    const task = makeTask({
      lastRunAt: "2025-06-01T11:58:00Z", // 2 min ago
      intervalSeconds: 300, // 5 min
    });
    expect(taskDue(task, now, 600)).toBe(false);
  });

  it("uses default interval when task interval is null", () => {
    const task = makeTask({
      lastRunAt: "2025-06-01T11:55:00Z", // 5 min ago
      intervalSeconds: null,
    });
    // default=300s (5 min), so exactly at boundary
    expect(taskDue(task, now, 300)).toBe(true);
    // default=600s (10 min), not yet
    expect(taskDue(task, now, 600)).toBe(false);
  });
});

describe("taskFilters", () => {
  let tmpDir: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-taskfilters-"));
    store = new StateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when no preset or filters", () => {
    const task = makeTask();
    const filters = taskFilters(task, store);
    expect(filters.limit).toBe(20);
  });

  it("uses preset filters when preset exists", () => {
    store.savePreset(scanPresetFromFilters("mypreset", {
      chains: ["base"],
      limit: 10,
      minLiquidityUsd: 50_000,
      minVolumeH24Usd: 100_000,
      minTxnsH1: 50,
      minPriceChangeH1: 0,
    }));

    const task = makeTask({ preset: "mypreset" });
    const filters = taskFilters(task, store);
    expect(filters.chains).toEqual(["base"]);
    expect(filters.limit).toBe(10);
    expect(filters.minLiquidityUsd).toBe(50_000);
  });

  it("overrides preset with task-level filters", () => {
    store.savePreset(scanPresetFromFilters("base-preset", defaultScanFilters()));
    const task = makeTask({
      preset: "base-preset",
      filters: { limit: 5, chains: ["ethereum"] },
    });
    const filters = taskFilters(task, store);
    expect(filters.limit).toBe(5);
    expect(filters.chains).toEqual(["ethereum"]);
  });

  it("handles snake_case filter keys", () => {
    const task = makeTask({
      filters: { min_liquidity_usd: 99_000, min_volume_h24_usd: 88_000 },
    });
    const filters = taskFilters(task, store);
    expect(filters.minLiquidityUsd).toBe(99_000);
    expect(filters.minVolumeH24Usd).toBe(88_000);
  });
});

describe("selectDueTasks", () => {
  let tmpDir: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-select-"));
    store = new StateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no tasks", () => {
    const result = selectDueTasks({
      store,
      defaultIntervalSeconds: 300,
    });
    expect(result).toEqual([]);
  });

  it("returns due tasks", () => {
    store.createTask({ name: "task1" });
    const result = selectDueTasks({
      store,
      defaultIntervalSeconds: 300,
    });
    expect(result).toHaveLength(1);
  });

  it("skips blocked tasks", () => {
    const task = store.createTask({ name: "blocked-task" });
    store.updateTaskStatus(task.id, "blocked");

    const result = selectDueTasks({
      store,
      defaultIntervalSeconds: 300,
    });
    expect(result).toHaveLength(0);
  });

  it("skips done tasks", () => {
    const task = store.createTask({ name: "done-task" });
    store.updateTaskStatus(task.id, "done");

    const result = selectDueTasks({
      store,
      defaultIntervalSeconds: 300,
    });
    expect(result).toHaveLength(0);
  });

  it("filters by task name", () => {
    store.createTask({ name: "alpha" });
    store.createTask({ name: "bravo" });

    const result = selectDueTasks({
      store,
      taskNameOrId: "alpha",
      defaultIntervalSeconds: 300,
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("alpha");
  });

  it("allTasks excludes blocked but includes all others", () => {
    const t1 = store.createTask({ name: "ok-task" });
    const t2 = store.createTask({ name: "blocked-task" });
    store.updateTaskStatus(t2.id, "blocked");

    const result = selectDueTasks({
      store,
      allTasks: true,
      defaultIntervalSeconds: 300,
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ok-task");
  });
});
