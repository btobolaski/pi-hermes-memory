import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_ROOT, defaultBackgroundSessionDir, resolveBackgroundSessionDir } from "../src/paths.js";
import { isPathInsideDirectory, shouldIndexSessionFile } from "../src/index.js";

describe("background session indexing guards", () => {
  it("computes the default background session directory under AGENT_ROOT", () => {
    assert.equal(
      defaultBackgroundSessionDir(),
      path.join(os.homedir(), ".pi", "agent", "sessions", "pi-hermes-memory"),
    );
  });

  it("resolves relative background session directories under AGENT_ROOT", () => {
    assert.equal(
      resolveBackgroundSessionDir({ backgroundSessionDir: "custom-bg" }),
      path.join(AGENT_ROOT, "custom-bg"),
    );
  });

  it("keeps absolute background session directories absolute", () => {
    const absolute = path.join(os.tmpdir(), "pi-hermes-memory-bg");
    assert.equal(resolveBackgroundSessionDir({ backgroundSessionDir: absolute }), absolute);
  });

  it("detects paths contained inside a parent directory", () => {
    const parent = path.join(os.tmpdir(), "parent-dir");
    const child = path.join(parent, "nested", "session.jsonl");
    const sibling = path.join(os.tmpdir(), "other-dir", "session.jsonl");

    assert.equal(isPathInsideDirectory(parent, child), true);
    assert.equal(isPathInsideDirectory(parent, sibling), false);
  });

  it("skips indexing for sessions inside the default background session directory", () => {
    const sessionFile = path.join(defaultBackgroundSessionDir(), "project", "session.jsonl");

    assert.equal(
      shouldIndexSessionFile(sessionFile, { logBackgroundSessions: true }),
      false,
    );
  });

  it("skips indexing for sessions inside a custom background session directory", () => {
    const backgroundSessionDir = path.join(os.tmpdir(), "custom-bg-sessions");
    const sessionFile = path.join(backgroundSessionDir, "project", "session.jsonl");

    assert.equal(
      shouldIndexSessionFile(sessionFile, { logBackgroundSessions: true, backgroundSessionDir }),
      false,
    );
  });

  it("still indexes normal sessions outside the background session directory", () => {
    const backgroundSessionDir = path.join(os.tmpdir(), "custom-bg-sessions");
    const sessionFile = path.join(os.tmpdir(), "foreground-sessions", "project", "session.jsonl");

    assert.equal(
      shouldIndexSessionFile(sessionFile, { logBackgroundSessions: true, backgroundSessionDir }),
      true,
    );
  });

  it("indexes foreground sessions when background session logging is disabled", () => {
    const sessionFile = path.join(defaultBackgroundSessionDir(), "project", "session.jsonl");

    assert.equal(
      shouldIndexSessionFile(sessionFile, { logBackgroundSessions: false }),
      true,
    );
  });
});
