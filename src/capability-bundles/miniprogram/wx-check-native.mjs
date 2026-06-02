#!/usr/bin/env node
/**
 * Native WeChat Mini Program fallback verifier (capability pack).
 * Static project-structure checks only; does not read capability manifest.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticLog = "debug/wx-check.log";
const logFile = join(repoRoot, diagnosticLog);
const logDir = dirname(logFile);

const UNSUPPORTED_BUILD_ROOTS = [
  "dist",
  "dist/build/mp-weixin",
  "unpackage/dist/dev/mp-weixin",
];

const TARO_DEP_PREFIX = "@tarojs/";
const DCLOUD_DEP_PREFIX = "@dcloudio/";
const MPVUE_DEP = "mpvue";
const UNI_APP_DEP = "uni-app";

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

const warn = (diagnostic, message, extra = {}) => {
  writeEvent({
    type: "native_check",
    severity: "warning",
    message,
    diagnostic,
    ...extra,
  });
};

const readJson = (filePath, invalidDiagnostic) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(invalidDiagnostic, `Invalid JSON in ${filePath}`, { file: filePath });
  }
};

const insideRepo = (absPath) => {
  const rel = relative(repoRoot, absPath);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
};

const collectProjectConfigsInDirectory = (directory) => {
  const configs = [];
  const direct = join(directory, "project.config.json");
  if (existsSync(direct)) {
    configs.push(direct);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const nested = join(directory, entry.name, "project.config.json");
    if (existsSync(nested)) {
      configs.push(nested);
    }
  }
  return configs;
};

const resolveProjectConfigPath = () => {
  const envPath = process.env.WX_PROJECT_CONFIG?.trim();
  if (!envPath) {
    return join(repoRoot, "project.config.json");
  }

  const candidate = resolve(repoRoot, envPath);
  if (!insideRepo(candidate)) {
    fail(
      "project_config_outside_repo",
      `WX_PROJECT_CONFIG must stay inside the repository: ${candidate}`,
      { file: candidate },
    );
  }

  if (!existsSync(candidate)) {
    fail(
      "project_config_missing",
      `WX_PROJECT_CONFIG path does not exist: ${candidate}`,
      { file: candidate },
    );
  }

  const stat = statSync(candidate);
  if (stat.isFile()) {
    return candidate;
  }

  if (stat.isDirectory()) {
    const configs = collectProjectConfigsInDirectory(candidate);
    if (configs.length === 0) {
      fail(
        "project_config_missing",
        `No project.config.json found under WX_PROJECT_CONFIG directory: ${candidate}`,
        { file: candidate },
      );
    }
    if (configs.length > 1) {
      fail(
        "project_config_ambiguous",
        `Multiple project.config.json files under WX_PROJECT_CONFIG; set WX_PROJECT_CONFIG to a specific file: ${configs.join(", ")}`,
        { file: candidate, candidates: configs },
      );
    }
    return configs[0];
  }

  fail(
    "project_config_missing",
    `WX_PROJECT_CONFIG is not a file or directory: ${candidate}`,
    { file: candidate },
  );
};

const readPackageJson = (dir) => {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
};

const dependencyNames = (pkg) => {
  if (!pkg) {
    return [];
  }
  const names = [];
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = pkg[section];
    if (deps && typeof deps === "object") {
      names.push(...Object.keys(deps));
    }
  }
  return names;
};

const hasDependencyMatch = (names, predicate) => names.some(predicate);

const rejectUnsupportedVariant = (reason, extra = {}) => {
  fail(
    "unsupported_miniprogram_variant",
    reason,
    { variant: extra.variant ?? "unknown", ...extra },
  );
};

const isUnsupportedBuildRoot = (miniprogramRoot, projectConfigDir) => {
  const rel = relative(projectConfigDir, miniprogramRoot).replace(/\\/g, "/");
  return UNSUPPORTED_BUILD_ROOTS.some(
    (pattern) => rel === pattern || rel.endsWith(`/${pattern}`),
  );
};

const isLocalComponentPath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("://") &&
  !value.startsWith("plugin:");

const resolveUnderRoot = (root, refPath, relativeBase) => {
  if (refPath.startsWith("/")) {
    return join(root, refPath.slice(1));
  }
  if (relativeBase) {
    return resolve(relativeBase, refPath);
  }
  return join(root, refPath);
};

const resolveFromMiniprogramRoot = (miniprogramRoot, refPath) =>
  resolveUnderRoot(miniprogramRoot, refPath);

const resolveComponentPath = (fromJsonFile, componentPath, miniprogramRoot) => {
  if (!isLocalComponentPath(componentPath)) {
    return null;
  }
  return resolveUnderRoot(
    miniprogramRoot,
    componentPath,
    dirname(fromJsonFile),
  );
};

const checkComponentFiles = (basePath, contextFile) => {
  const jsonPath = `${basePath}.json`;
  const wxmlPath = `${basePath}.wxml`;
  if (!existsSync(jsonPath)) {
    fail(
      "component_json_missing",
      `Missing component JSON: ${jsonPath}`,
      { file: jsonPath, context: contextFile },
    );
  }
  readJson(jsonPath, "component_json_invalid");
  if (!existsSync(wxmlPath)) {
    fail(
      "component_wxml_missing",
      `Missing component WXML: ${wxmlPath}`,
      { file: wxmlPath, context: contextFile },
    );
  }
};

const collectUsingComponents = (json, fromFile) => {
  const entries = [];
  const using = json?.usingComponents;
  if (!using || typeof using !== "object") {
    return entries;
  }
  for (const [name, ref] of Object.entries(using)) {
    if (isLocalComponentPath(ref)) {
      entries.push({ name, ref, fromFile });
    }
  }
  return entries;
};

const verifyLocalUsingComponents = (json, fromFile, miniprogramRoot) => {
  for (const entry of collectUsingComponents(json, fromFile)) {
    const componentBase = resolveComponentPath(
      fromFile,
      entry.ref,
      miniprogramRoot,
    );
    if (componentBase) {
      checkComponentFiles(componentBase, fromFile);
    }
  }
};

const detectUnsupportedFrameworkSignals = (projectConfigPath, miniprogramRoot) => {
  const projectConfigDir = dirname(projectConfigPath);
  const pkgNames = dependencyNames(readPackageJson(repoRoot));

  if (
    hasDependencyMatch(pkgNames, (name) => name.startsWith(TARO_DEP_PREFIX))
  ) {
    rejectUnsupportedVariant(
      "Taro project detected (@tarojs/* dependency). Use npm run wx:check for cross-framework validation.",
      { variant: "taro" },
    );
  }

  if (
    hasDependencyMatch(
      pkgNames,
      (name) => name.startsWith(DCLOUD_DEP_PREFIX) || name === UNI_APP_DEP,
    )
  ) {
    rejectUnsupportedVariant(
      "uni-app project detected (@dcloudio/* or uni-app dependency). Use npm run wx:check for cross-framework validation.",
      { variant: "uni-app" },
    );
  }

  if (hasDependencyMatch(pkgNames, (name) => name === MPVUE_DEP)) {
    rejectUnsupportedVariant(
      "mpvue project detected (mpvue dependency). Use npm run wx:check for cross-framework validation.",
      { variant: "mpvue" },
    );
  }

  if (
    existsSync(join(projectConfigDir, "manifest.json")) &&
    existsSync(join(projectConfigDir, "pages.json"))
  ) {
    rejectUnsupportedVariant(
      "uni-app project detected (manifest.json and pages.json near project config). Use npm run wx:check for cross-framework validation.",
      { variant: "uni-app" },
    );
  }

  if (isUnsupportedBuildRoot(miniprogramRoot, projectConfigDir)) {
    rejectUnsupportedVariant(
      `miniprogramRoot points at a cross-framework build output (${relative(projectConfigDir, miniprogramRoot)}). Use npm run wx:check for generated dist validation.`,
      { variant: "build_output", miniprogramRoot },
    );
  }
};

const verifyPages = (pages, appJsonPath, miniprogramRoot) => {
  for (const pagePath of pages) {
    if (typeof pagePath !== "string" || !pagePath.trim()) {
      fail(
        "app_page_invalid",
        "app.json pages entries must be non-empty strings",
        { file: appJsonPath },
      );
    }
    const pageBase = resolveFromMiniprogramRoot(miniprogramRoot, pagePath);
    if (!insideRepo(pageBase)) {
      fail(
        "page_path_outside_repo",
        `Page path escapes the repository: ${pagePath}`,
        { file: appJsonPath, page: pagePath },
      );
    }
    const relToRoot = relative(miniprogramRoot, pageBase);
    if (relToRoot.startsWith("..")) {
      fail(
        "page_path_outside_root",
        `Page path must resolve inside miniprogramRoot: ${pagePath}`,
        { file: appJsonPath, page: pagePath, miniprogramRoot },
      );
    }
    const pageJson = `${pageBase}.json`;
    const pageWxml = `${pageBase}.wxml`;
    if (!existsSync(pageJson)) {
      fail(
        "page_json_missing",
        `Missing page JSON: ${pageJson}`,
        { file: pageJson, page: pagePath },
      );
    }
    const pageJsonData = readJson(pageJson, "page_json_invalid");
    if (!existsSync(pageWxml)) {
      fail(
        "page_wxml_missing",
        `Missing page WXML: ${pageWxml}`,
        { file: pageWxml, page: pagePath },
      );
    }

    verifyLocalUsingComponents(pageJsonData, pageJson, miniprogramRoot);
  }
};

const verifyTabBar = (tabBar, pages, appJsonPath, miniprogramRoot) => {
  if (!tabBar?.list || !Array.isArray(tabBar.list)) {
    return;
  }

  for (const item of tabBar.list) {
    const pagePath = item?.pagePath;
    if (typeof pagePath === "string" && !pages.includes(pagePath)) {
      fail(
        "tabbar_page_not_declared",
        `tabBar pagePath "${pagePath}" is not listed in app.json pages`,
        { file: appJsonPath, pagePath },
      );
    }
    for (const iconField of ["iconPath", "selectedIconPath"]) {
      const iconPath = item?.[iconField];
      if (typeof iconPath !== "string" || !iconPath.trim()) {
        continue;
      }
      const iconFile = resolveFromMiniprogramRoot(miniprogramRoot, iconPath);
      if (!existsSync(iconFile)) {
        fail(
          "tabbar_icon_missing",
          `Missing tabBar ${iconField} asset: ${iconFile}`,
          { file: iconFile, iconField, pagePath },
        );
      }
    }
  }
};

const runNativeCheck = () => {
  const projectConfigPath = resolveProjectConfigPath();

  if (!insideRepo(projectConfigPath)) {
    fail(
      "project_config_outside_repo",
      `project.config.json must stay inside the repository: ${projectConfigPath}`,
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

  const projectConfig = readJson(
    projectConfigPath,
    "project_config_invalid",
  );

  const compileType = projectConfig.compileType;
  if (compileType != null && compileType !== "miniprogram") {
    fail(
      "compile_type_incompatible",
      `compileType "${compileType}" is not compatible with native Mini Program verification`,
      { file: projectConfigPath, compileType },
    );
  }

  const miniprogramRoot = resolve(
    dirname(projectConfigPath),
    projectConfig.miniprogramRoot ?? ".",
  );

  if (!insideRepo(miniprogramRoot)) {
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

  detectUnsupportedFrameworkSignals(projectConfigPath, miniprogramRoot);

  const appJsonPath = join(miniprogramRoot, "app.json");
  if (!existsSync(appJsonPath)) {
    fail(
      "app_json_missing",
      `Missing app.json under miniprogramRoot: ${appJsonPath}`,
      { file: appJsonPath, miniprogramRoot },
    );
  }

  const appJson = readJson(appJsonPath, "app_json_invalid");
  const pages = appJson.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    fail(
      "app_pages_empty",
      "app.json pages must be a non-empty array",
      { file: appJsonPath },
    );
  }

  verifyPages(pages, appJsonPath, miniprogramRoot);
  verifyLocalUsingComponents(appJson, appJsonPath, miniprogramRoot);
  verifyTabBar(appJson.tabBar, pages, appJsonPath, miniprogramRoot);

  writeEvent({
    type: "native_check",
    severity: "info",
    message: "Native Mini Program static checks passed.",
    diagnostic: "native_check_passed",
    file: projectConfigPath,
    miniprogramRoot,
    platform_validation_status: "not_configured",
  });

  process.exit(0);
};

runNativeCheck();
