/**
 * Per-worker git config and Hub data isolation.
 *
 * Vitest runs test files in parallel across forked worker processes.
 * Multiple tests call `git config --global` (e.g. to add safe.directory),
 * which writes to the file at GIT_CONFIG_GLOBAL. When all workers share a
 * single file, concurrent writes race on `.gitconfig.lock` and cause
 * intermittent "could not lock config file" failures.
 *
 * This setup file runs inside each worker process (via vitest `setupFiles`),
 * giving every worker its own gitconfig file and isolated XDG data/config/cache
 * roots so Hub registry I/O cannot touch the real user data directory.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-worker-"));
const globalConfigPath = join(tmpDir, ".gitconfig");
writeFileSync(
  globalConfigPath,
  "[user]\n\temail = test@test.com\n\tname = Test\n",
);
process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

const xdgRoot = mkdtempSync(join(tmpdir(), "archloop-test-xdg-worker-"));
process.env.XDG_DATA_HOME = join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = join(xdgRoot, "config");
process.env.XDG_CACHE_HOME = join(xdgRoot, "cache");

process.on("exit", () => {
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
  try {
    rmSync(xdgRoot, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});
