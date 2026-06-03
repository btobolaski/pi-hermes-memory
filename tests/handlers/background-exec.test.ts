import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryConfig } from "../../src/types.js";
import { runBackgroundPi, BACKGROUND_TOOLS } from "../../src/handlers/background-exec.js";

let execCalls: Array<{ cmd: string; args: string[]; opts: { signal?: AbortSignal; timeout?: number } }>;
let tempDirs: string[];

type ExecOutcome =
  | { code: number; stdout?: string; stderr?: string }
  | Error;

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function createMockPi(outcomes: ExecOutcome[] = [{ code: 0, stdout: "ok", stderr: "" }]) {
  const queue = [...outcomes];

  return {
    on() {},
    registerTool() {},
    registerCommand() {},
    async exec(cmd: string, args: string[], opts: { signal?: AbortSignal; timeout?: number }) {
      execCalls.push({ cmd, args, opts });
      const next = queue.shift() ?? { code: 0, stdout: "ok", stderr: "" };
      if (next instanceof Error) throw next;
      return {
        code: next.code,
        stdout: next.stdout ?? "",
        stderr: next.stderr ?? "",
      };
    },
  } as any;
}

function makeTempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function defaultConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    memoryMode: "policy-only",
    memoryPolicyStyle: "full",
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewRecentMessages: 0,
    reviewEnabled: true,
    logBackgroundSessions: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    flushRecentMessages: 0,
    autoConsolidate: true,
    correctionDetection: true,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 60000,
    ...overrides,
  };
}

describe("runBackgroundPi", () => {
  beforeEach(() => {
    execCalls = [];
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses one default-model attempt when backgroundModels is undefined", async () => {
    const sessionDir = path.join(makeTempDir("bg-default-model"), "sessions");
    const pi = createMockPi([{ code: 0, stdout: "saved", stderr: "" }]);

    const result = await runBackgroundPi(pi, "prompt", defaultConfig({ backgroundSessionDir: sessionDir }), {
      timeoutMs: 1234,
    });

    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cmd, "pi");
    assert.equal(execCalls[0].args[0], "-p");
    assert.ok(execCalls[0].args.includes(BACKGROUND_TOOLS));
    assert.ok(!execCalls[0].args.includes("--model"), "should not include --model");
    assert.equal(result.modelUsed, null);
    assert.deepEqual(result.attemptedModels, ["(default)"]);
  });

  it("uses a configured model when backgroundModels has one entry", async () => {
    const sessionDir = path.join(makeTempDir("bg-single-model"), "sessions");
    const pi = createMockPi([{ code: 0, stdout: "saved", stderr: "" }]);
    const model = "anthropic/claude-haiku-4-5";

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: [model], backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000 },
    );

    assert.equal(execCalls.length, 1);
    assert.ok(execCalls[0].args.includes(BACKGROUND_TOOLS), "should pass --tools allowlist");
    assert.equal(getFlagValue(execCalls[0].args, "--model"), model);
    assert.equal(execCalls[0].args.at(-1), "prompt");
    assert.equal(result.modelUsed, model);
    assert.deepEqual(result.attemptedModels, [model]);
  });

  it("falls back to the second model after a non-zero exit", async () => {
    const sessionDir = path.join(makeTempDir("bg-fallback-success"), "sessions");
    const pi = createMockPi([
      { code: 1, stdout: "", stderr: "bad model" },
      { code: 0, stdout: "saved", stderr: "" },
    ]);
    const models = ["anthropic/bad", "openai/gpt-4.1-mini"];

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: models, backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000 },
    );

    assert.equal(execCalls.length, 2);
    assert.equal(getFlagValue(execCalls[0].args, "--model"), models[0]);
    assert.equal(getFlagValue(execCalls[1].args, "--model"), models[1]);
    assert.equal(result.code, 0);
    assert.equal(result.modelUsed, models[1]);
    assert.deepEqual(result.attemptedModels, models);
  });

  it("returns the last failing result when all models fail", async () => {
    const sessionDir = path.join(makeTempDir("bg-all-fail"), "sessions");
    const models = ["anthropic/one", "openai/two"];
    const pi = createMockPi([
      { code: 1, stdout: "", stderr: "first failed" },
      { code: 2, stdout: "", stderr: "second failed" },
    ]);

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: models, backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000 },
    );

    assert.equal(execCalls.length, 2);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "second failed");
    assert.equal(result.modelUsed, null);
    assert.deepEqual(result.attemptedModels, models);
  });

  it("treats thrown exec errors as failures and advances fallback", async () => {
    const sessionDir = path.join(makeTempDir("bg-throw"), "sessions");
    const models = ["anthropic/one", "openai/two"];
    const pi = createMockPi([
      new Error("timeout"),
      { code: 0, stdout: "saved", stderr: "" },
    ]);

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: models, backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000 },
    );

    assert.equal(execCalls.length, 2);
    assert.equal(result.code, 0);
    assert.equal(result.modelUsed, models[1]);
    assert.deepEqual(result.attemptedModels, models);
  });

  it("uses --session-dir by default and does not pass --no-session", async () => {
    const sessionDir = path.join(makeTempDir("bg-session-dir"), "sessions");
    const pi = createMockPi();

    await runBackgroundPi(pi, "prompt", defaultConfig({ backgroundSessionDir: sessionDir }), {
      timeoutMs: 1000,
    });

    assert.ok(execCalls[0].args.includes("--session-dir"));
    assert.ok(execCalls[0].args.includes(sessionDir));
    assert.ok(!execCalls[0].args.includes("--no-session"));
  });

  it("uses --no-session when logBackgroundSessions is false", async () => {
    const sessionDir = path.join(makeTempDir("bg-no-session"), "sessions");
    const pi = createMockPi();

    await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ logBackgroundSessions: false, backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000 },
    );

    assert.ok(execCalls[0].args.includes("--no-session"));
    assert.ok(!execCalls[0].args.includes("--session-dir"));
  });

  it("honors maxAttempts when the model chain is longer", async () => {
    const sessionDir = path.join(makeTempDir("bg-max-attempts"), "sessions");
    const models = ["anthropic/one", "openai/two", "google/three"];
    const pi = createMockPi([
      { code: 1, stdout: "", stderr: "first failed" },
      { code: 0, stdout: "saved", stderr: "" },
    ]);

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: models, backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000, maxAttempts: 1 },
    );

    assert.equal(execCalls.length, 1);
    assert.equal(result.code, 1);
    assert.deepEqual(result.attemptedModels, [models[0]]);
  });

  it("returns the sentinel result without exec calls when the signal is already aborted", async () => {
    const sessionDir = path.join(makeTempDir("bg-aborted"), "sessions");
    const controller = new AbortController();
    controller.abort();
    const pi = createMockPi();

    const result = await runBackgroundPi(
      pi,
      "prompt",
      defaultConfig({ backgroundModels: ["anthropic/one"], backgroundSessionDir: sessionDir }),
      { timeoutMs: 1000, signal: controller.signal },
    );

    assert.equal(execCalls.length, 0);
    assert.equal(result.code, -1);
    assert.equal(result.stderr, "no attempts made");
    assert.deepEqual(result.attemptedModels, []);
  });

  it("creates the background session directory before execution", async () => {
    const rootDir = makeTempDir("bg-create-dir");
    const sessionDir = path.join(rootDir, "nested", "sessions");
    fs.rmSync(rootDir, { recursive: true, force: true });

    const pi = createMockPi();
    await runBackgroundPi(pi, "prompt", defaultConfig({ backgroundSessionDir: sessionDir }), {
      timeoutMs: 1000,
    });

    assert.ok(fs.existsSync(sessionDir), "background session dir should exist after run");
  });
});
