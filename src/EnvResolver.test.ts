import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEnv } from "./EnvResolver.js";

const makeDir = () => mkdtemp(join(tmpdir(), "env-resolver-"));

let originalXdgDataHome: string | undefined;
let originalCodexHome: string | undefined;
let originalGhConfigDir: string | undefined;

beforeEach(async () => {
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalCodexHome = process.env.CODEX_HOME;
  originalGhConfigDir = process.env.GH_CONFIG_DIR;
  process.env.XDG_DATA_HOME = await mkdtemp(
    join(tmpdir(), "env-resolver-xdg-"),
  );
  delete process.env.CODEX_HOME;
  delete process.env.GH_CONFIG_DIR;
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
  else process.env.GH_CONFIG_DIR = originalGhConfigDir;
});

const runResolveEnv = (dir: string) =>
  Effect.runPromise(resolveEnv(dir).pipe(Effect.provide(NodeContext.layer)));

describe("resolveEnv", () => {
  it("returns all key-value pairs from .archloop/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      "ANTHROPIC_API_KEY=sc-key\nGH_TOKEN=sc-gh\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sc-key",
      GH_TOKEN: "sc-gh",
    });
  });

  it("ignores repo root .env — keys from root .env do not appear in result", async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, ".env"),
      "ROOT_SECRET=should-not-appear\nANOTHER_ROOT_KEY=also-ignored\n",
    );

    const env = await runResolveEnv(dir);
    expect(env["ROOT_SECRET"]).toBeUndefined();
    expect(env["ANOTHER_ROOT_KEY"]).toBeUndefined();
    expect(env).toEqual({});
  });

  it("root .env is ignored even when .archloop/.env also exists", async () => {
    const dir = await makeDir();
    await writeFile(join(dir, ".env"), "ROOT_ONLY=root-val\nSHARED=root\n");
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      "SC_ONLY=sc-val\nSHARED=sc\n",
    );

    const env = await runResolveEnv(dir);
    expect(env["ROOT_ONLY"]).toBeUndefined();
    expect(env["SC_ONLY"]).toBe("sc-val");
    expect(env["SHARED"]).toBe("sc"); // only .archloop/.env is used
  });

  it("falls back to process.env for keys declared in .archloop/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    // .archloop/.env declares the key but with empty value
    await writeFile(join(dir, ".archloop", ".env"), "MY_TOKEN=\n");

    const orig = process.env["MY_TOKEN"];
    try {
      process.env["MY_TOKEN"] = "from-process";
      const env = await runResolveEnv(dir);
      expect(env["MY_TOKEN"]).toBe("from-process");
    } finally {
      if (orig === undefined) delete process.env["MY_TOKEN"];
      else process.env["MY_TOKEN"] = orig;
    }
  });

  it("does NOT pull keys from process.env that are not in .archloop/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "DECLARED_KEY=value\n");

    // PATH is always in process.env but should not appear in result
    const env = await runResolveEnv(dir);
    expect(env["PATH"]).toBeUndefined();
    expect(env["HOME"]).toBeUndefined();
    expect(env["DECLARED_KEY"]).toBe("value");
  });

  it(".archloop/.env takes precedence over process.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "MY_VAR=sc-val\n");

    const orig = process.env["MY_VAR"];
    try {
      process.env["MY_VAR"] = "from-process";
      const env = await runResolveEnv(dir);
      expect(env["MY_VAR"]).toBe("sc-val");
    } finally {
      if (orig === undefined) delete process.env["MY_VAR"];
      else process.env["MY_VAR"] = orig;
    }
  });

  it("returns empty object when no .env files exist", async () => {
    const dir = await makeDir();
    const env = await runResolveEnv(dir);
    expect(env).toEqual({});
  });

  it("ignores comments and blank lines in .archloop/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      "# This is a comment\n\nKEY1=val1\n\n# Another comment\nKEY2=val2\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({ KEY1: "val1", KEY2: "val2" });
  });

  it("does no validation — returns whatever keys are present in .archloop/.env", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    // Only custom keys, no ANTHROPIC_API_KEY or GH_TOKEN
    await writeFile(
      join(dir, ".archloop", ".env"),
      "NPM_TOKEN=npm123\nDATABASE_URL=pg://localhost\n",
    );

    const env = await runResolveEnv(dir);
    expect(env).toEqual({
      NPM_TOKEN: "npm123",
      DATABASE_URL: "pg://localhost",
    });
  });

  it("strips matching double quotes from values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      'ANTHROPIC_API_KEY="sk-ant-api03-real-key"\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-real-key");
  });

  it("strips matching single quotes from values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "TOKEN='my-token'\n");

    const env = await runResolveEnv(dir);
    expect(env["TOKEN"]).toBe("my-token");
  });

  it("leaves mismatched quotes as-is", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), `KEY="value'\n`);

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe(`"value'`);
  });

  it("leaves interior quotes as-is", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), 'KEY=some"thing\n');

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe('some"thing');
  });

  it("handles empty quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), 'KEY=""\n');

    const env = await runResolveEnv(dir);
    expect(env).toEqual({});
  });

  it("process.env fallback works for keys in .archloop/.env too", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "FALLBACK_KEY=\n");

    const orig = process.env["FALLBACK_KEY"];
    try {
      process.env["FALLBACK_KEY"] = "from-env";
      const env = await runResolveEnv(dir);
      expect(env["FALLBACK_KEY"]).toBe("from-env");
    } finally {
      if (orig === undefined) delete process.env["FALLBACK_KEY"];
      else process.env["FALLBACK_KEY"] = orig;
    }
  });

  it("unescapes \\n in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), 'KEY="line1\\nline2"\n');

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("line1\nline2");
  });

  it("does not unescape \\n in single-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "KEY='line1\\nline2'\n");

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("line1\\nline2");
  });

  it("preserves internal whitespace in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), 'KEY="  spaced  "\n');

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("  spaced  ");
  });

  it("unescapes \\r, \\t, and \\\\ in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(
      join(dir, ".archloop", ".env"),
      'TAB="a\\tb"\nCR="a\\rb"\nBS="a\\\\b"\n',
    );

    const env = await runResolveEnv(dir);
    expect(env["TAB"]).toBe("a\tb");
    expect(env["CR"]).toBe("a\rb");
    expect(env["BS"]).toBe("a\\b");
  });

  it("handles escaped backslash before n in double-quoted values", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), 'KEY="a\\\\nb"\n');

    const env = await runResolveEnv(dir);
    // \\n in the file → literal backslash + literal n (not a newline)
    expect(env["KEY"]).toBe("a\\nb");
  });

  it("parses unquoted values unchanged", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "KEY=plain\n");

    const env = await runResolveEnv(dir);
    expect(env["KEY"]).toBe("plain");
  });

  it("loads Hub env values when the project has no .archloop/.env", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    await mkdir(join(dataDir, "archloop"), { recursive: true });
    await writeFile(
      join(dataDir, "archloop", ".env"),
      "CURSOR_API_KEY=hub-cursor\n",
    );

    const orig = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = dataDir;
      const env = await runResolveEnv(dir);
      expect(env).toEqual({ CURSOR_API_KEY: "hub-cursor" });
    } finally {
      if (orig === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = orig;
      }
    }
  });

  it("loads Hub auth session paths when provider auth directories contain login state", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    const codexDir = join(dataDir, "archloop", "hub", "auth", "codex");
    const githubDir = join(dataDir, "archloop", "hub", "auth", "github");
    await mkdir(codexDir, { recursive: true });
    await mkdir(githubDir, { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "{}\n");
    await writeFile(join(githubDir, "hosts.yml"), "github.com: {}\n");

    const orig = process.env.XDG_DATA_HOME;
    const origCodexHome = process.env.CODEX_HOME;
    const origGhConfigDir = process.env.GH_CONFIG_DIR;
    try {
      process.env.XDG_DATA_HOME = dataDir;
      delete process.env.CODEX_HOME;
      delete process.env.GH_CONFIG_DIR;
      const env = await runResolveEnv(dir);
      expect(env.CODEX_HOME).toBe(codexDir);
      expect(env.GH_CONFIG_DIR).toBe(githubDir);
    } finally {
      if (orig === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = orig;
      if (origCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = origCodexHome;
      if (origGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = origGhConfigDir;
    }
  });

  it("does not override an explicitly declared CODEX_HOME with Hub auth session state", async () => {
    const dir = await makeDir();
    const dataDir = join(dir, "xdg-data");
    const codexDir = join(dataDir, "archloop", "hub", "auth", "codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "auth.json"), "{}\n");
    await mkdir(join(dir, ".archloop"));
    await writeFile(join(dir, ".archloop", ".env"), "CODEX_HOME=/custom\n");

    const orig = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = dataDir;
      const env = await runResolveEnv(dir);
      expect(env.CODEX_HOME).toBe("/custom");
    } finally {
      if (orig === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = orig;
    }
  });
});
