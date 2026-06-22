import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PINNED_BEADS_VERSION,
  isBdAvailable,
  resolveBdExecutable,
  resolveBundledBdExecutable,
} from "./resolveBdExecutable.js";

describe("resolveBdExecutable", () => {
  it("exports the pinned Beads version", () => {
    expect(PINNED_BEADS_VERSION).toBe("1.0.4");
  });

  it("prefers ARCHLOOP_BD_PATH when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolve-bd-"));
    const bdPath = join(dir, "custom-bd");
    await writeFile(bdPath, "#!/bin/sh\nexit 0\n");
    await chmod(bdPath, 0o755);

    expect(
      resolveBdExecutable({
        ...process.env,
        ARCHLOOP_BD_PATH: bdPath,
      }),
    ).toBe(bdPath);
  });

  it("falls back to the bundled bd binary when override is missing", () => {
    expect(
      resolveBdExecutable({
        ...process.env,
        ARCHLOOP_BD_PATH: join(tmpdir(), "missing-bd"),
      }),
    ).toBe(resolveBundledBdExecutable() ?? "bd");
  });
});

describe("resolveBundledBdExecutable", () => {
  it("resolves the bundled @beads/bd executable when installed", () => {
    const bundledPath = resolveBundledBdExecutable();
    if (!bundledPath) {
      expect(bundledPath).toBeUndefined();
      return;
    }

    expect(bundledPath).toContain(
      process.platform === "win32"
        ? "@beads\\bd\\bin\\bd.exe"
        : "@beads/bd/bin/bd",
    );
  });
});

describe("isBdAvailable", () => {
  it("returns true when ARCHLOOP_BD_PATH points to an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolve-bd-"));
    const bdPath = join(dir, "custom-bd");
    await writeFile(bdPath, "#!/bin/sh\nexit 0\n");
    await chmod(bdPath, 0o755);

    expect(
      isBdAvailable({
        ...process.env,
        ARCHLOOP_BD_PATH: bdPath,
        PATH: "",
      }),
    ).toBe(true);
  });

  it("detects the bundled binary even when PATH lookup is unavailable", () => {
    expect(
      isBdAvailable({
        ...process.env,
        PATH: "",
        ARCHLOOP_BD_PATH: "",
      }),
    ).toBe(resolveBundledBdExecutable() !== undefined);
  });
});
