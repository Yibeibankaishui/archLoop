import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const HUB_LANDING_PUBLISH_POLICIES = [
  "off",
  "best_effort",
  "required",
] as const;

export type HubLandingPublishPolicy =
  (typeof HUB_LANDING_PUBLISH_POLICIES)[number];

export const HUB_LANDING_CHECKOUT_SYNC_POLICIES = [
  "safe_fast_forward",
] as const;

export type HubLandingCheckoutSyncPolicy =
  (typeof HUB_LANDING_CHECKOUT_SYNC_POLICIES)[number];

export interface HubLandingPolicy {
  readonly version: 1;
  readonly hostTargetBranch: string;
  readonly publishTargetRef: string;
  readonly fenceRef: string;
  readonly publishPolicy: HubLandingPublishPolicy;
  readonly remoteTarget?: string;
  /** Max wait for required remote proof during a run; ms. */
  readonly deliveryTimeoutMs?: number;
  readonly checkoutSyncPolicy: HubLandingCheckoutSyncPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnsureHubLandingPolicyInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly now?: Date;
}

export interface EnsureHubLandingPolicyResult {
  readonly created: boolean;
  readonly policy: HubLandingPolicy;
  readonly path: string;
}

export interface ConfigureHubLandingPolicyInput {
  readonly repoRoot: string;
  readonly hubProjectDir: string;
  readonly publishPolicy?: HubLandingPublishPolicy;
  readonly remoteTarget?: string | null;
  readonly deliveryTimeoutMs?: number | null;
  readonly now?: Date;
}

export interface ConfigureHubLandingPolicyResult {
  readonly policy: HubLandingPolicy;
  readonly path: string;
}

const POLICY_FILE_NAME = "landing-policy.json";

const isPublishPolicy = (value: unknown): value is HubLandingPublishPolicy =>
  value === "off" || value === "best_effort" || value === "required";

const isCheckoutSyncPolicy = (
  value: unknown,
): value is HubLandingCheckoutSyncPolicy => value === "safe_fast_forward";

const readObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const fsyncPath = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const writeAtomicJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsyncPath(tempPath);
  renameSync(tempPath, path);
};

const gitText = (repoRoot: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

const gitOk = (repoRoot: string, args: readonly string[]): boolean => {
  try {
    execFileSync("git", [...args], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const resolveHostTargetBranch = (repoRoot: string): string => {
  const current = gitText(repoRoot, ["branch", "--show-current"]);
  if (current.length > 0) {
    return current;
  }
  const symbolic = gitOk(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ])
    ? gitText(repoRoot, ["symbolic-ref", "--short", "HEAD"])
    : "";
  if (symbolic.length > 0) {
    return symbolic;
  }
  if (gitOk(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"])) {
    return "main";
  }
  if (
    gitOk(repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"])
  ) {
    return "master";
  }
  throw new Error(
    "Unable to pin a Hub host target branch from a detached HEAD without main or master.",
  );
};

const sanitizeRefToken = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";

export const resolveHubLandingPolicyPath = (hubProjectDir: string): string =>
  join(hubProjectDir, POLICY_FILE_NAME);

export const resolveHubLandingTargetIdentity = (
  hubProjectDir: string,
): string => {
  const projectId = sanitizeRefToken(basename(hubProjectDir));
  const digest = createHash("sha256")
    .update(hubProjectDir)
    .digest("hex")
    .slice(0, 12);
  return `${projectId}-${digest}`;
};

const parseHubLandingPolicy = (value: unknown): HubLandingPolicy | undefined => {
  const record = readObject(value);
  if (record.version !== 1) {
    return undefined;
  }
  const hostTargetBranch = readString(record, "hostTargetBranch");
  const publishTargetRef = readString(record, "publishTargetRef");
  const fenceRef = readString(record, "fenceRef");
  const publishPolicy = record.publishPolicy;
  const checkoutSyncPolicy = record.checkoutSyncPolicy;
  const createdAt = readString(record, "createdAt");
  const updatedAt = readString(record, "updatedAt");
  if (
    !hostTargetBranch ||
    !publishTargetRef ||
    !fenceRef ||
    !isPublishPolicy(publishPolicy) ||
    !isCheckoutSyncPolicy(checkoutSyncPolicy) ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }
  const remoteTarget = readString(record, "remoteTarget");
  const deliveryTimeoutMs =
    typeof record.deliveryTimeoutMs === "number" &&
    Number.isFinite(record.deliveryTimeoutMs) &&
    record.deliveryTimeoutMs > 0
      ? Math.floor(record.deliveryTimeoutMs)
      : undefined;
  return {
    version: 1,
    hostTargetBranch,
    publishTargetRef,
    fenceRef,
    publishPolicy,
    ...(remoteTarget ? { remoteTarget } : {}),
    ...(deliveryTimeoutMs !== undefined ? { deliveryTimeoutMs } : {}),
    checkoutSyncPolicy,
    createdAt,
    updatedAt,
  };
};

export const readHubLandingPolicy = (
  hubProjectDir: string,
): HubLandingPolicy | undefined => {
  const path = resolveHubLandingPolicyPath(hubProjectDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return parseHubLandingPolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

const writeInitialFenceBlob = (repoRoot: string, now: string): string => {
  const payload = `${JSON.stringify({
    kind: "hub-landing-fence",
    ownerNonce: randomUUID(),
    pid: process.pid,
    createdAt: now,
  })}\n`;
  return execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repoRoot,
    encoding: "utf8",
    input: payload,
  }).trim();
};

const ensureGitRef = (
  repoRoot: string,
  ref: string,
  oid: string,
): void => {
  if (gitOk(repoRoot, ["show-ref", "--verify", "--quiet", ref])) {
    return;
  }
  execFileSync("git", ["update-ref", ref, oid], { cwd: repoRoot });
};

export const ensureHubLandingPolicy = (
  input: EnsureHubLandingPolicyInput,
): EnsureHubLandingPolicyResult => {
  mkdirSync(input.hubProjectDir, { recursive: true });
  const path = resolveHubLandingPolicyPath(input.hubProjectDir);
  const existing = readHubLandingPolicy(input.hubProjectDir);
  if (existing) {
    const headOid = gitText(input.repoRoot, ["rev-parse", "HEAD"]);
    ensureGitRef(input.repoRoot, existing.publishTargetRef, headOid);
    if (
      !gitOk(input.repoRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        existing.fenceRef,
      ])
    ) {
      ensureGitRef(
        input.repoRoot,
        existing.fenceRef,
        writeInitialFenceBlob(input.repoRoot, existing.updatedAt),
      );
    }
    return { created: false, policy: existing, path };
  }

  const now = (input.now ?? new Date()).toISOString();
  const hostTargetBranch = resolveHostTargetBranch(input.repoRoot);
  const targetIdentity = resolveHubLandingTargetIdentity(input.hubProjectDir);
  const policy: HubLandingPolicy = {
    version: 1,
    hostTargetBranch,
    publishTargetRef: `refs/archloop/publish/${targetIdentity}`,
    fenceRef: `refs/archloop/fence/${targetIdentity}`,
    publishPolicy: "off",
    checkoutSyncPolicy: "safe_fast_forward",
    createdAt: now,
    updatedAt: now,
  };
  const headOid = gitText(input.repoRoot, ["rev-parse", "HEAD"]);
  const fenceOid = writeInitialFenceBlob(input.repoRoot, now);
  ensureGitRef(input.repoRoot, policy.publishTargetRef, headOid);
  ensureGitRef(input.repoRoot, policy.fenceRef, fenceOid);
  writeAtomicJson(path, policy);
  return { created: true, policy, path };
};

export const configureHubLandingPolicy = (
  input: ConfigureHubLandingPolicyInput,
): ConfigureHubLandingPolicyResult => {
  const ensured = ensureHubLandingPolicy(input);
  if (
    input.publishPolicy === undefined &&
    input.remoteTarget === undefined &&
    input.deliveryTimeoutMs === undefined
  ) {
    return { policy: ensured.policy, path: ensured.path };
  }

  const now = (input.now ?? new Date()).toISOString();
  const remoteTarget = resolveConfiguredRemoteTarget(
    input.remoteTarget,
    ensured.policy.remoteTarget,
  );
  const deliveryTimeoutMs = resolveConfiguredDeliveryTimeoutMs(
    input.deliveryTimeoutMs,
    ensured.policy.deliveryTimeoutMs,
  );
  // Rebuild without spreading so cleared optional fields stay omitted.
  const policy: HubLandingPolicy = {
    version: 1,
    hostTargetBranch: ensured.policy.hostTargetBranch,
    publishTargetRef: ensured.policy.publishTargetRef,
    fenceRef: ensured.policy.fenceRef,
    publishPolicy: input.publishPolicy ?? ensured.policy.publishPolicy,
    ...(remoteTarget ? { remoteTarget } : {}),
    ...(deliveryTimeoutMs !== undefined ? { deliveryTimeoutMs } : {}),
    checkoutSyncPolicy: ensured.policy.checkoutSyncPolicy,
    createdAt: ensured.policy.createdAt,
    updatedAt: now,
  };
  writeAtomicJson(ensured.path, policy);
  return { policy, path: ensured.path };
};

const resolveConfiguredRemoteTarget = (
  input: string | null | undefined,
  current: string | undefined,
): string | undefined => {
  if (input === undefined) {
    return current;
  }
  if (input === null || input.trim().length === 0) {
    return undefined;
  }
  return input.trim();
};

const resolveConfiguredDeliveryTimeoutMs = (
  input: number | null | undefined,
  current: number | undefined,
): number | undefined => {
  if (input === undefined) {
    return current;
  }
  if (input === null || input <= 0) {
    return undefined;
  }
  return Math.floor(input);
};
