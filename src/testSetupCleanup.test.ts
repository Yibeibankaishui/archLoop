import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeTestTempDirectories } from "./testSetupCleanup.js";

describe("test setup temp cleanup", () => {
  it("removes every owned root and remains idempotent", async () => {
    const first = await mkdtemp(join(tmpdir(), "archloop-cleanup-first-"));
    const second = await mkdtemp(join(tmpdir(), "archloop-cleanup-second-"));
    mkdirSync(join(first, "nested"));
    mkdirSync(join(second, "nested"));

    removeTestTempDirectories([first, second]);
    removeTestTempDirectories([first, second]);

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });
});
