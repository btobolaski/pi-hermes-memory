import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import { resolveBackgroundSessionDir } from "../paths.js";

export interface BackgroundExecOptions {
  /** Per-attempt timeout in milliseconds. Applied to each model attempt. */
  timeoutMs: number;
  /** Optional abort signal. If aborted between attempts, fallback stops. */
  signal?: AbortSignal;
  /** Cap on number of model attempts. Default: backgroundModels.length || 1. */
  maxAttempts?: number;
}

export interface BackgroundExecResult {
  code: number;
  stdout: string;
  stderr: string;
  attemptedModels: string[];
  modelUsed: string | null;
}

function buildSessionFlags(config: MemoryConfig): string[] {
  if (config.logBackgroundSessions === false) return ["--no-session"];

  const dir = resolveBackgroundSessionDir(config);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort only; pi will surface a real session-dir failure.
  }
  return ["--session-dir", dir];
}

export async function runBackgroundPi(
  pi: ExtensionAPI,
  prompt: string,
  config: MemoryConfig,
  opts: BackgroundExecOptions,
): Promise<BackgroundExecResult> {
  const configuredModels = config.backgroundModels ?? [];
  const modelChain: Array<string | null> = configuredModels.length > 0 ? configuredModels : [null];
  const attemptCap = Math.max(1, opts.maxAttempts ?? modelChain.length);
  const chain = modelChain.slice(0, attemptCap);
  const sessionFlags = buildSessionFlags(config);
  const attemptedModels: string[] = [];

  let lastResult: BackgroundExecResult = {
    code: -1,
    stdout: "",
    stderr: "no attempts made",
    attemptedModels,
    modelUsed: null,
  };

  for (const model of chain) {
    if (opts.signal?.aborted) break;

    const args = ["-p", ...sessionFlags];
    if (model) args.push("--model", model);
    args.push(prompt);

    const label = model ?? "(default)";
    attemptedModels.push(label);

    try {
      const result = await pi.exec("pi", args, {
        signal: opts.signal,
        timeout: opts.timeoutMs,
      });

      if (result.code === 0) {
        return {
          code: result.code,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          attemptedModels: [...attemptedModels],
          modelUsed: model,
        };
      }

      lastResult = {
        code: result.code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        attemptedModels: [...attemptedModels],
        modelUsed: null,
      };
    } catch (error) {
      lastResult = {
        code: -1,
        stdout: "",
        stderr: String(error),
        attemptedModels: [...attemptedModels],
        modelUsed: null,
      };
    }
  }

  return lastResult;
}
