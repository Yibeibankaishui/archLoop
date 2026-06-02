#!/usr/bin/env node
/**
 * Native WeChat Mini Program fallback verifier (capability pack scaffold).
 * Full project-shape and platform validation behavior is expanded in follow-up work.
 * Does not depend on the capability manifest.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticLog = "debug/wx-check.log";
const logFile = join(repoRoot, diagnosticLog);

const writeEvent = (event) => {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(logFile, `${JSON.stringify(event)}\n`, "utf8");
};

const fail = (diagnostic, message, extra = {}) => {
  writeEvent({
    type: "native_check",
    severity: "error",
    message,
    diagnostic,
    ...extra,
  });
  process.exit(1);
};

const projectConfigEnv = process.env.WX_PROJECT_CONFIG?.trim();
const projectConfigPath = projectConfigEnv
  ? resolve(repoRoot, projectConfigEnv)
  : join(repoRoot, "project.config.json");

if (projectConfigEnv && relative(repoRoot, projectConfigPath).startsWith("..")) {
  fail(
    "project_config_outside_repo",
    `WX_PROJECT_CONFIG must stay inside the repository: ${projectConfigPath}`,
    { file: projectConfigPath },
  );
}

if (!existsSync(projectConfigPath)) {
  fail(
    "project_config_missing",
    "No usable project.config.json found. Set WX_PROJECT_CONFIG or add project.config.json at the repository root.",
    { file: projectConfigPath },
  );
}

let projectConfig;
try {
  projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf8"));
} catch {
  fail("project_config_invalid", `Invalid JSON in ${projectConfigPath}`, {
    file: projectConfigPath,
  });
}

const miniprogramRoot = resolve(
  dirname(projectConfigPath),
  projectConfig.miniprogramRoot ?? ".",
);
const miniprogramRel = relative(repoRoot, miniprogramRoot);
if (miniprogramRel.startsWith("..")) {
  fail(
    "miniprogram_root_outside_repo",
    `miniprogramRoot must stay inside the repository: ${miniprogramRoot}`,
    { miniprogramRoot },
  );
}

if (!existsSync(miniprogramRoot)) {
  fail(
    "miniprogram_root_missing",
    `miniprogramRoot directory does not exist: ${miniprogramRoot}`,
    { miniprogramRoot },
  );
}

writeEvent({
  type: "native_check",
  severity: "info",
  message:
    "Native Mini Program scaffold checks passed (project.config.json and miniprogramRoot present). Deeper structure and platform validation run in follow-up verifier work.",
  diagnostic: "native_scaffold_passed",
  file: projectConfigPath,
  miniprogramRoot,
  platform_validation_status: "not_configured",
});

process.exit(0);
