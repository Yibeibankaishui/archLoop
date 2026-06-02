import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINIPROGRAM_CAPABILITY_PACK_ID,
  type CapabilitySetupAction,
  type ResolvedCapabilityInit,
} from "./capabilityPacks.js";

const PLACEHOLDER_APPIDS = new Set(["touristappid", "wx0000000000000000"]);

const VERIFICATION_ARTIFACT_GITIGNORE_PATTERNS = [
  "debug/wx-check.log",
  "debug/wx-preview.jpg",
  "debug/wx-check-",
  "debug/wx-preview-",
] as const;

const MINIPROGRAM_BUNDLE_FILES = [
  "verify.sh",
  "wx-check-native.mjs",
  "context/miniprogram.md",
  "auth/wx-upload/.gitignore",
] as const;

export function getMiniprogramCapabilityBundlesRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "capability-bundles", "miniprogram");
}

export function validateMiniprogramCapabilityBundle(): void {
  const root = getMiniprogramCapabilityBundlesRoot();
  for (const relativePath of MINIPROGRAM_BUNDLE_FILES) {
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      throw new Error(`Missing Mini Program capability bundle file: ${path}`);
    }
  }
}

export type MiniprogramCiStatus =
  | "available"
  | "missing"
  | "detected_but_unusable";

export type AppIdDetectionStatus =
  | "wx_appid"
  | "project_config"
  | "missing"
  | "placeholder";

export type UploadKeyDetectionStatus =
  | "wx_upload_key_path"
  | "repo_local"
  | "missing";

export interface MiniprogramInitSnapshot {
  readonly miniprogramCi: {
    readonly status: MiniprogramCiStatus;
    readonly version?: string;
    readonly source?: "project_local";
  };
  readonly appid: {
    readonly status: AppIdDetectionStatus;
    readonly effectiveAppid?: string;
    readonly wxAppid?: string;
    readonly projectConfigAppid?: string;
  };
  readonly uploadKey: {
    readonly status: UploadKeyDetectionStatus;
    readonly path?: string;
  };
  readonly wxCheckScriptPresent: boolean;
  readonly verificationArtifactsIgnored: boolean | "not_git_repo";
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function availableMiniprogramCi(
  version: string,
): MiniprogramInitSnapshot["miniprogramCi"] {
  return { status: "available", version, source: "project_local" };
}

function readMiniprogramCiPackage(
  packageJsonPath: string,
): MiniprogramInitSnapshot["miniprogramCi"] {
  const pkg = readJsonFile<{ version?: string }>(packageJsonPath);
  if (!pkg?.version) {
    return { status: "detected_but_unusable" };
  }
  return availableMiniprogramCi(pkg.version);
}

function detectMiniprogramCi(
  repoDir: string,
): MiniprogramInitSnapshot["miniprogramCi"] {
  try {
    const requireFromRepo = createRequire(join(repoDir, "package.json"));
    const pkgPath = requireFromRepo.resolve("miniprogram-ci/package.json");
    return readMiniprogramCiPackage(pkgPath);
  } catch {
    const nodeModulesPkg = join(
      repoDir,
      "node_modules",
      "miniprogram-ci",
      "package.json",
    );
    if (!existsSync(nodeModulesPkg)) {
      return { status: "missing" };
    }
    return readMiniprogramCiPackage(nodeModulesPkg);
  }
}

function readProjectConfigAppid(repoDir: string): string | undefined {
  const configPath = join(repoDir, "project.config.json");
  if (!existsSync(configPath)) return undefined;
  const config = readJsonFile<{ appid?: string }>(configPath);
  const appid = config?.appid?.trim();
  return appid || undefined;
}

function isPlaceholderAppid(appid: string | undefined): boolean {
  return appid !== undefined && PLACEHOLDER_APPIDS.has(appid.toLowerCase());
}

function detectAppid(repoDir: string): MiniprogramInitSnapshot["appid"] {
  const wxAppid = process.env.WX_APPID?.trim();
  const projectConfigAppid = readProjectConfigAppid(repoDir);
  const effectiveAppid = wxAppid || projectConfigAppid;

  if (!effectiveAppid) {
    return { status: "missing" };
  }
  if (isPlaceholderAppid(effectiveAppid)) {
    return {
      status: "placeholder",
      effectiveAppid,
      ...(wxAppid ? { wxAppid } : {}),
      ...(projectConfigAppid ? { projectConfigAppid } : {}),
    };
  }
  if (wxAppid) {
    return {
      status: "wx_appid",
      effectiveAppid,
      wxAppid,
      ...(projectConfigAppid ? { projectConfigAppid } : {}),
    };
  }
  return {
    status: "project_config",
    effectiveAppid,
    projectConfigAppid,
  };
}

function detectUploadKey(
  repoDir: string,
  effectiveAppid: string | undefined,
): MiniprogramInitSnapshot["uploadKey"] {
  const wxUploadKeyPath = process.env.WX_UPLOAD_KEY_PATH?.trim();
  if (wxUploadKeyPath) {
    return { status: "wx_upload_key_path", path: wxUploadKeyPath };
  }
  if (effectiveAppid) {
    const repoKey = join(
      repoDir,
      ".sandcastle",
      "auth",
      "wx-upload",
      `private.${effectiveAppid}.key`,
    );
    if (existsSync(repoKey)) {
      return { status: "repo_local", path: repoKey };
    }
  }
  return { status: "missing" };
}

function detectWxCheckScript(repoDir: string): boolean {
  const pkg = readJsonFile<{ scripts?: Record<string, string> }>(
    join(repoDir, "package.json"),
  );
  return Boolean(pkg?.scripts?.["wx:check"]?.trim());
}

function detectVerificationArtifactsIgnored(
  repoDir: string,
): boolean | "not_git_repo" {
  if (!existsSync(join(repoDir, ".git"))) {
    return "not_git_repo";
  }
  const gitignorePath = join(repoDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    return false;
  }
  const content = readFileSync(gitignorePath, "utf8");
  return VERIFICATION_ARTIFACT_GITIGNORE_PATTERNS.every((pattern) =>
    content.includes(pattern),
  );
}

/** Init-time detection used for setup checklist and capability manifest setup actions. */
export function detectMiniprogramInitSnapshot(
  repoDir: string,
): MiniprogramInitSnapshot {
  const appid = detectAppid(repoDir);
  return {
    miniprogramCi: detectMiniprogramCi(repoDir),
    appid,
    uploadKey: detectUploadKey(repoDir, appid.effectiveAppid),
    wxCheckScriptPresent: detectWxCheckScript(repoDir),
    verificationArtifactsIgnored: detectVerificationArtifactsIgnored(repoDir),
  };
}

function skippedMiniprogramCiInstallAction(
  reason: string,
  summary: string,
): CapabilitySetupAction {
  return {
    id: "miniprogram-ci-install",
    status: "skipped",
    reason,
    summary,
  };
}

export function buildMiniprogramSetupActions(
  snapshot: MiniprogramInitSnapshot,
): CapabilitySetupAction[] {
  const { miniprogramCi } = snapshot;
  if (miniprogramCi.status === "available") {
    return [
      skippedMiniprogramCiInstallAction(
        "already_available",
        `Project-local miniprogram-ci ${miniprogramCi.version ?? ""} detected`.trim(),
      ),
    ];
  }
  if (miniprogramCi.status === "detected_but_unusable") {
    return [
      skippedMiniprogramCiInstallAction(
        "detected_but_unusable",
        "miniprogram-ci is present but failed the lightweight availability probe; reinstall or fix the package.",
      ),
    ];
  }
  return [
    skippedMiniprogramCiInstallAction(
      "user_declined",
      "miniprogram-ci not installed during init. Run npm install -D miniprogram-ci (or pnpm/yarn equivalent) when you want platform preview validation.",
    ),
  ];
}

function formatAppidSection(snapshot: MiniprogramInitSnapshot): string {
  const { appid } = snapshot;
  switch (appid.status) {
    case "wx_appid":
      return `- **AppID:** \`${appid.effectiveAppid}\` from \`WX_APPID\` (overrides project.config.json).`;
    case "project_config":
      return `- **AppID:** \`${appid.effectiveAppid}\` from \`project.config.json\`.`;
    case "placeholder":
      return `- **AppID:** placeholder (\`${appid.effectiveAppid}\`) — treat as missing for platform validation. Set a real AppID via \`WX_APPID\` or \`project.config.json\`.`;
    default:
      return "- **AppID:** not detected. Set `WX_APPID` or add `appid` to `project.config.json` for platform validation.";
  }
}

function formatMiniprogramCiSection(snapshot: MiniprogramInitSnapshot): string {
  const { miniprogramCi } = snapshot;
  if (miniprogramCi.status === "available") {
    return `- **miniprogram-ci:** project-local package available (${miniprogramCi.version ?? "version unknown"}).`;
  }
  if (miniprogramCi.status === "detected_but_unusable") {
    return "- **miniprogram-ci:** detected but unusable — reinstall or fix the project-local package.";
  }
  return "- **miniprogram-ci:** not installed. Recommended for platform preview validation (AppID + upload key + IP allowlist).";
}

function formatVerificationArtifactsIgnoreLine(
  ignored: MiniprogramInitSnapshot["verificationArtifactsIgnored"],
): string {
  if (ignored === "not_git_repo") {
    return "Git metadata not found — add `debug/wx-check.log` and `debug/wx-preview.jpg` to `.gitignore` manually.";
  }
  if (ignored) {
    return "Host `.gitignore` appears to ignore Mini Program verification artifacts.";
  }
  return "Add `debug/wx-check.log`, `debug/wx-preview.jpg`, and related `debug/wx-*` patterns to the host `.gitignore`.";
}

function formatUploadKeySection(snapshot: MiniprogramInitSnapshot): string {
  const { uploadKey, appid } = snapshot;
  if (uploadKey.status === "wx_upload_key_path") {
    return `- **Upload key:** \`WX_UPLOAD_KEY_PATH\` → \`${uploadKey.path}\` (preferred).`;
  }
  if (uploadKey.status === "repo_local") {
    return `- **Upload key:** repository-local \`${uploadKey.path}\` (gitignored).`;
  }
  const hintAppid = appid.effectiveAppid ?? "{appid}";
  return `- **Upload key:** not detected. Prefer \`WX_UPLOAD_KEY_PATH\` outside the repo, or place \`.sandcastle/auth/wx-upload/private.${hintAppid}.key\` (never commit \`private.*.key\`).`;
}

/** Init-time setup checklist snapshot (not updated by verify.sh). */
export function renderMiniprogramSetupChecklist(
  snapshot: MiniprogramInitSnapshot,
): string {
  const wxCheck = snapshot.wxCheckScriptPresent
    ? "- **wx:check:** `npm run wx:check` is defined; `.sandcastle/verify.sh` will run it first."
    : "- **wx:check:** no project script; `.sandcastle/verify.sh` falls back to `.sandcastle/wx-check-native.mjs`.";

  return `# Mini Program setup checklist

> Init-time snapshot — not updated by \`.sandcastle/verify.sh\` or \`.sandcastle/wx-check-native.mjs\`.

## Detected state

${formatMiniprogramCiSection(snapshot)}
${formatAppidSection(snapshot)}
${formatUploadKeySection(snapshot)}
${wxCheck}
- **Verification artifacts:** ${formatVerificationArtifactsIgnoreLine(snapshot.verificationArtifactsIgnored)}

## Next steps

1. Run \`.sandcastle/verify.sh\` after Mini Program changes; read \`debug/wx-check.log\` on failure.
2. Install project-local \`miniprogram-ci\` when you want automated preview validation (\`npm install -D miniprogram-ci\`).
3. Configure a real AppID (\`WX_APPID\` or \`project.config.json\`) and upload key for platform validation.
4. In the [WeChat public platform](https://mp.weixin.qq.com/), configure the code upload private key and **IP allowlist** for CI preview/upload.
5. Ignore verification run outputs in git (\`debug/wx-check.log\`, \`debug/wx-preview.jpg\`).

## Safety reminders

- Never commit WeChat code upload private keys (\`private.*.key\`).
- Prefer \`WX_UPLOAD_KEY_PATH\` pointing **outside** the repository.
- Sandcastle does not generate, copy, or manage upload keys during init.
`;
}

const copyBundleFile = (
  fs: FileSystem.FileSystem,
  bundlesRoot: string,
  configDir: string,
  relativePath: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const from = join(bundlesRoot, relativePath);
    const to = join(configDir, relativePath);
    yield* fs
      .makeDirectory(dirname(to), { recursive: true })
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const content = yield* fs
      .readFileString(from)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* fs
      .writeFileString(to, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/** Writes Mini Program core capability scaffold into `.sandcastle/`. */
export const scaffoldMiniprogramCapabilityCore = (
  configDir: string,
  repoDir: string,
): Effect.Effect<
  { setupActions: readonly CapabilitySetupAction[] },
  Error,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    validateMiniprogramCapabilityBundle();
    const fs = yield* FileSystem.FileSystem;
    const bundlesRoot = getMiniprogramCapabilityBundlesRoot();
    const snapshot = detectMiniprogramInitSnapshot(repoDir);
    const setupActions = buildMiniprogramSetupActions(snapshot);

    for (const relativePath of MINIPROGRAM_BUNDLE_FILES) {
      yield* copyBundleFile(fs, bundlesRoot, configDir, relativePath);
    }

    yield* fs
      .writeFileString(
        join(configDir, "context", "miniprogram-setup.md"),
        renderMiniprogramSetupChecklist(snapshot),
      )
      .pipe(Effect.mapError((e) => new Error(e.message)));

    yield* Effect.tryPromise({
      try: () => chmod(join(configDir, "verify.sh"), 0o755),
      catch: (e) => new Error(String(e)),
    });

    return { setupActions };
  });

export function shouldScaffoldMiniprogramCore(
  capabilityInit: ResolvedCapabilityInit | undefined,
): boolean {
  return (
    capabilityInit?.capabilityId === MINIPROGRAM_CAPABILITY_PACK_ID &&
    capabilityInit.writeCapabilityManifest
  );
}
