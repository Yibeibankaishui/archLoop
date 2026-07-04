import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgents } from "./InitService.js";
import { formatMissingAgentCredentialsMessage } from "./agentAuthGuidance.js";
import { Output } from "./Output.js";
import {
  formatMissingHubAgentRolesMessage,
  listMissingHubAgentRoles,
  readHubAgentConfig,
  validateHubAgentRoleEntry,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";
import { resolveHubAuthSessionEnv } from "./hubAuth.js";
import { resolveHubAgentProvider } from "./hubProposalAgent.js";
import { resolveHubEnv } from "./hubEnv.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";
import { run } from "./run.js";

export type HubReadinessSeverity = "success" | "warn" | "error";

export interface HubReadinessFinding {
  readonly severity: HubReadinessSeverity;
  readonly title: string;
  readonly message: string;
}

export interface HubReadinessSection {
  readonly title: string;
  readonly findings: readonly HubReadinessFinding[];
}

export interface HubReadinessCheckReport {
  readonly sections: readonly HubReadinessSection[];
  readonly hasWarnings: boolean;
  readonly hasErrors: boolean;
}

export interface HubReadinessCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly smokeCheckRunner?: HubProviderSmokeCheckRunner;
}

interface ProviderReference {
  readonly provider: string;
  readonly model: string;
  readonly roles: readonly string[];
  readonly options?: HubAgentRoleEntry["options"];
}

interface ProviderRequirements {
  readonly credentialEnvKeys?: readonly string[];
  readonly authEnvKey?: string;
  readonly toolCommand?: string;
}

interface ProviderKeyInput {
  readonly provider: string;
  readonly model: string;
  readonly options?: HubAgentRoleEntry["options"];
}

interface ProviderReadinessMap {
  readonly findings: readonly HubReadinessFinding[];
  readonly readyByKey: ReadonlyMap<string, boolean>;
}

export interface HubProviderSmokeCheckInput {
  readonly provider: string;
  readonly model: string;
  readonly roles: readonly string[];
  readonly options?: HubAgentRoleEntry["options"];
}

export type HubProviderSmokeCheckRunner = (
  input: HubProviderSmokeCheckInput,
) => Promise<string>;

const providerRequirements: Readonly<Record<string, ProviderRequirements>> = {
  "claude-code": {
    credentialEnvKeys: ["ANTHROPIC_API_KEY"],
    toolCommand: "claude",
  },
  codex: {
    credentialEnvKeys: ["OPENAI_KEY"],
    authEnvKey: "CODEX_HOME",
    toolCommand: "codex",
  },
  cursor: {
    credentialEnvKeys: ["CURSOR_API_KEY"],
    toolCommand: "agent",
  },
  github: {
    authEnvKey: "GH_CONFIG_DIR",
  },
  opencode: {
    credentialEnvKeys: ["OPENCODE_API_KEY"],
    toolCommand: "opencode",
  },
  pi: {
    credentialEnvKeys: ["ANTHROPIC_API_KEY"],
    toolCommand: "pi",
  },
};

const listOptionEntries = (
  options: HubAgentRoleEntry["options"],
): ReadonlyArray<readonly [string, string]> =>
  options
    ? Object.entries(options)
        .filter(([, value]) => value.trim().length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
    : [];

const normalizeOptionsKey = (
  options: HubAgentRoleEntry["options"],
): string | undefined => {
  const entries = listOptionEntries(options);
  return entries.length > 0 ? JSON.stringify(entries) : undefined;
};

const formatProviderOptions = (
  options: HubAgentRoleEntry["options"],
): string => {
  const entries = listOptionEntries(options);
  if (entries.length === 0) {
    return "";
  }

  return ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
};

const formatProviderReference = (reference: ProviderReference): string => {
  const roles = reference.roles.join(", ");
  const model = reference.model.length > 0 ? ` / ${reference.model}` : "";
  return `${roles}: ${reference.provider}${model}${formatProviderOptions(reference.options)}`;
};

const resolveProviderLabel = (provider: string): string =>
  listAgents().find((entry) => entry.name === provider)?.label ?? provider;

const commandExists = (command: string, env: NodeJS.ProcessEnv): boolean => {
  const checkCommand =
    process.platform === "win32" ? `where ${command}` : `command -v ${command}`;
  try {
    execSync(checkCommand, {
      stdio: "ignore",
      env: {
        ...process.env,
        ...env,
      },
    });
    return true;
  } catch {
    return false;
  }
};

const getProviderRequirements = (provider: string): ProviderRequirements =>
  providerRequirements[provider] ?? {};

const readRoleEntries = (config: ReturnType<typeof readHubAgentConfig>) => {
  const missingRoles = listMissingHubAgentRoles(config);
  const validEntries: Array<{ role: string; entry: HubAgentRoleEntry }> = [];
  const errors: HubReadinessFinding[] = [];

  for (const [role, entry] of Object.entries(config.roles)) {
    if (!entry) {
      continue;
    }

    try {
      validateHubAgentRoleEntry(role, entry);
      validEntries.push({
        role,
        entry,
      });
    } catch (error) {
      errors.push({
        severity: "error",
        title: `Invalid Hub agent role ${role}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (missingRoles.length > 0) {
    errors.unshift({
      severity: "error",
      title: "Missing Hub agent roles",
      message: formatMissingHubAgentRolesMessage(missingRoles),
    });
  }

  return { validEntries, errors, missingRoles };
};

const referenceKey = (reference: ProviderKeyInput): string =>
  [
    reference.provider,
    reference.model,
    normalizeOptionsKey(reference.options) ?? "",
  ].join("::");

const collectProviderReferences = (
  validEntries: readonly { role: string; entry: HubAgentRoleEntry }[],
): readonly ProviderReference[] => {
  const references = new Map<string, ProviderReference>();

  for (const { role, entry } of validEntries) {
    const key = referenceKey(entry);
    const existing = references.get(key);
    if (existing) {
      references.set(key, {
        ...existing,
        roles: [...existing.roles, role].sort(),
      });
      continue;
    }

    references.set(key, {
      provider: entry.provider,
      model: entry.model,
      roles: [role],
      options: entry.options,
    });
  }

  return [...references.values()].sort((left, right) =>
    formatProviderReference(left).localeCompare(formatProviderReference(right)),
  );
};

const collectCredentialFindings = (
  references: readonly ProviderReference[],
  options: HubReadinessCheckOptions,
): ProviderReadinessMap => {
  const runtimeEnv = options.env ?? process.env;
  const hubEnv = resolveHubEnv({ env: runtimeEnv, homeDir: options.homeDir });
  const hubAuthEnv = resolveHubAuthSessionEnv({
    env: runtimeEnv,
    homeDir: options.homeDir,
  });

  const findings: HubReadinessFinding[] = [];
  const readyByKey = new Map<string, boolean>();
  for (const reference of references) {
    const key = referenceKey(reference);
    const providerLabel = resolveProviderLabel(reference.provider);
    const requirements = getProviderRequirements(reference.provider);
    const envKeys = requirements.credentialEnvKeys ?? [];
    const authEnvKey = requirements.authEnvKey;

    const envSatisfied = envKeys.some((key) => {
      const value = hubEnv[key] ?? runtimeEnv[key] ?? "";
      return value.trim().length > 0;
    });
    const authSatisfied =
      authEnvKey !== undefined &&
      (hubAuthEnv[authEnvKey] ?? runtimeEnv[authEnvKey] ?? "").trim().length >
        0;

    if (envSatisfied || authSatisfied) {
      findings.push({
        severity: "success",
        title: `${providerLabel} credentials`,
        message: `${formatProviderReference(reference)} has a configured credential source.`,
      });
      readyByKey.set(key, true);
      continue;
    }

    const missingEnvKey = envKeys[0];
    const message =
      missingEnvKey === undefined
        ? `Hub agent provider "${reference.provider}" does not expose a credential key.`
        : formatMissingAgentCredentialsMessage({
            providerName: reference.provider,
            envKey: missingEnvKey,
            label: providerLabel,
          });
    findings.push({
      severity: "error",
      title: `${providerLabel} credentials`,
      message,
    });
    readyByKey.set(key, false);
  }

  return { findings, readyByKey };
};

const collectToolFindings = (
  references: readonly ProviderReference[],
  options: HubReadinessCheckOptions,
): ProviderReadinessMap => {
  const runtimeEnv = options.env ?? process.env;
  const findings: HubReadinessFinding[] = [];
  const readyByKey = new Map<string, boolean>();

  for (const reference of references) {
    const key = referenceKey(reference);
    const command = getProviderRequirements(reference.provider).toolCommand;
    const providerLabel = resolveProviderLabel(reference.provider);

    if (!command) {
      findings.push({
        severity: "error",
        title: `${providerLabel} tool`,
        message: `Hub agent provider "${reference.provider}" does not map to a known CLI command.`,
      });
      readyByKey.set(key, false);
      continue;
    }

    if (!commandExists(command, runtimeEnv)) {
      findings.push({
        severity: "error",
        title: `${providerLabel} tool`,
        message: `Provider CLI "${command}" is not available on PATH for ${formatProviderReference(reference)}.`,
      });
      readyByKey.set(key, false);
      continue;
    }

    findings.push({
      severity: "success",
      title: `${providerLabel} tool`,
      message: `Found provider CLI "${command}" for ${formatProviderReference(reference)}.`,
    });
    readyByKey.set(key, true);
  }

  return { findings, readyByKey };
};

const SMOKE_TOKEN = "ARCHLOOP_SMOKE_OK";
const SMOKE_TAG = "smoke";
const SMOKE_PROMPT = [
  "This is an archLoop Hub provider smoke check.",
  `Reply with exactly <${SMOKE_TAG}>${SMOKE_TOKEN}</${SMOKE_TAG}>.`,
].join(" ");

const buildSmokeRepo = async (): Promise<string> => {
  const repoDir = await mkdtemp(join(tmpdir(), "archloop-hub-smoke-"));
  try {
    execSync("git init -b main", { cwd: repoDir, stdio: "ignore" });
    execSync('git config user.email "smoke@archloop.local"', {
      cwd: repoDir,
      stdio: "ignore",
    });
    execSync('git config user.name "archLoop smoke"', {
      cwd: repoDir,
      stdio: "ignore",
    });
    await writeFile(join(repoDir, "smoke.txt"), "smoke\n", "utf8");
    execSync("git add smoke.txt", { cwd: repoDir, stdio: "ignore" });
    execSync('git commit -m "smoke repo"', { cwd: repoDir, stdio: "ignore" });
    return repoDir;
  } catch (error) {
    await rm(repoDir, { recursive: true, force: true });
    throw error;
  }
};

const buildSmokeRepairCommands = (provider: string): string[] => {
  const requirements = getProviderRequirements(provider);
  const commands: string[] = [];

  if (requirements.credentialEnvKeys) {
    for (const envKey of requirements.credentialEnvKeys) {
      commands.push(`archloop env set ${envKey} <value>`);
    }
  }

  if (provider === "codex" || provider === "github") {
    commands.push(`archloop auth login ${provider}`);
  }

  commands.push("archloop env show");
  commands.push("archloop auth show");
  commands.push("archloop agent-config show");
  return commands;
};

const smokeFindingTitle = (provider: string): string =>
  `${resolveProviderLabel(provider)} smoke`;

const formatSmokeFailureMessage = (input: {
  readonly reference: ProviderReference;
  readonly error: unknown;
}): string => {
  const providerLabel = resolveProviderLabel(input.reference.provider);
  const detail =
    input.error instanceof Error ? input.error.message : String(input.error);
  const lines = [
    `Provider/model smoke check failed for ${formatProviderReference(input.reference)}.`,
    `Roles covered: ${input.reference.roles.join(", ")}.`,
    `The check used the real ${providerLabel} provider path and did not bypass the agent runtime.`,
    "",
    "Repair commands:",
    ...buildSmokeRepairCommands(input.reference.provider).map(
      (command) => `- ${command}`,
    ),
    "",
    `Original error: ${detail.trim()}`,
  ];
  return lines.join("\n");
};

const runDefaultSmokeCheck: HubProviderSmokeCheckRunner = async (input) => {
  const repoDir = await buildSmokeRepo();
  try {
    const agent = resolveHubAgentProvider({
      provider: input.provider,
      model: input.model,
      options: input.options,
    });

    const result = await run({
      agent,
      sandbox: noSandbox(),
      cwd: repoDir,
      prompt: SMOKE_PROMPT,
      output: Output.string({ tag: SMOKE_TAG }),
      completionSignal: `<${SMOKE_TAG}>${SMOKE_TOKEN}</${SMOKE_TAG}>`,
      maxIterations: 1,
      name: `hub-smoke-${input.provider}`,
      logging: {
        type: "file",
        path: join(repoDir, ".archloop", "logs", "hub-smoke.log"),
      },
    });

    if (result.output !== SMOKE_TOKEN) {
      throw new Error(
        `Smoke check returned "${result.output}" instead of "${SMOKE_TOKEN}".`,
      );
    }

    return result.output;
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
};

const collectSkippedRoleFindings = (
  missingRoles: readonly string[],
): readonly HubReadinessFinding[] =>
  missingRoles.length > 0
    ? [
        {
          severity: "warn",
          title: "Unconfigured Hub agent roles",
          message: `Skipped provider/model smoke checks for: ${missingRoles.join(", ")}.`,
        },
      ]
    : [];

const buildSkippedRoleSection = (
  missingRoles: readonly string[],
): HubReadinessSection | undefined => {
  const findings = collectSkippedRoleFindings(missingRoles);
  return findings.length > 0
    ? {
        title: "Skipping unconfigured Hub agent roles",
        findings,
      }
    : undefined;
};

const collectSmokeFindings = async (
  references: readonly ProviderReference[],
  readiness: {
    readonly credentials: ReadonlyMap<string, boolean>;
    readonly tools: ReadonlyMap<string, boolean>;
  },
  smokeCheckRunner: HubProviderSmokeCheckRunner = runDefaultSmokeCheck,
): Promise<HubReadinessFinding[]> => {
  const findings: HubReadinessFinding[] = [];

  for (const reference of references) {
    const key = referenceKey(reference);
    const credentialsReady = readiness.credentials.get(key) ?? false;
    const toolReady = readiness.tools.get(key) ?? false;

    if (!credentialsReady || !toolReady) {
      findings.push({
        severity: "warn",
        title: smokeFindingTitle(reference.provider),
        message: `Skipped ${formatProviderReference(reference)} because credential or tool validation failed earlier in the check.`,
      });
      continue;
    }

    try {
      const token = await smokeCheckRunner({
        provider: reference.provider,
        model: reference.model,
        roles: reference.roles,
        options: reference.options,
      });
      findings.push({
        severity: "success",
        title: smokeFindingTitle(reference.provider),
        message: [
          `Real provider smoke check passed for ${formatProviderReference(reference)}.`,
          `Roles covered: ${reference.roles.join(", ")}.`,
          `Smoke response token: ${token}.`,
        ].join("\n"),
      });
    } catch (error) {
      findings.push({
        severity: "error",
        title: smokeFindingTitle(reference.provider),
        message: formatSmokeFailureMessage({ reference, error }),
      });
    }
  }

  return findings;
};

const buildRoleSuccessFindings = (): readonly HubReadinessFinding[] => [
  {
    severity: "success",
    title: "Hub agent roles",
    message: "All required Hub agent roles are configured and validated.",
  },
];

const reportHasSeverity = (
  report: HubReadinessSection[],
  severity: HubReadinessSeverity,
): boolean =>
  report.some((section) =>
    section.findings.some((finding) => finding.severity === severity),
  );

const summarizeReport = (report: HubReadinessCheckReport): string => {
  if (report.hasErrors) {
    return "Hub readiness check failed.";
  }

  if (report.hasWarnings) {
    return "Hub readiness check completed with warnings.";
  }

  return "Hub readiness check passed.";
};

export const collectHubReadinessChecks = async (
  options: HubReadinessCheckOptions = {},
): Promise<HubReadinessCheckReport> => {
  const config = readHubAgentConfig(options);
  const roleCheck = readRoleEntries(config);
  const references = collectProviderReferences(roleCheck.validEntries);
  const sections: HubReadinessSection[] = [
    {
      title: "Checking Hub agent roles",
      findings:
        roleCheck.errors.length > 0
          ? roleCheck.errors
          : buildRoleSuccessFindings(),
    },
  ];
  const skippedRoleSection = buildSkippedRoleSection(roleCheck.missingRoles);
  if (skippedRoleSection) {
    sections.push(skippedRoleSection);
  }

  if (references.length > 0) {
    sections.push({
      title: "Checking configured provider references",
      findings: references.map((reference) => ({
        severity: "success" as const,
        title: `${resolveProviderLabel(reference.provider)} reference`,
        message: formatProviderReference(reference),
      })),
    });

    const credentialCheck = collectCredentialFindings(references, options);
    const toolCheck = collectToolFindings(references, options);

    sections.push({
      title: "Checking Hub env and auth",
      findings: credentialCheck.findings,
    });
    sections.push({
      title: "Checking required tools",
      findings: toolCheck.findings,
    });

    const smokeFindings = await collectSmokeFindings(
      references,
      {
        credentials: credentialCheck.readyByKey,
        tools: toolCheck.readyByKey,
      },
      options.smokeCheckRunner,
    );
    if (smokeFindings.length > 0) {
      sections.push({
        title: "Checking provider/model smoke",
        findings: smokeFindings,
      });
    }
  }

  const hasWarnings = reportHasSeverity(sections, "warn");
  const hasErrors = reportHasSeverity(sections, "error");

  return { sections, hasWarnings, hasErrors };
};

const formatFindingLines = (finding: HubReadinessFinding): string[] => {
  const lines = [`  ${finding.severity.toUpperCase()}: ${finding.title}`];
  for (const line of finding.message.split("\n")) {
    if (line.length > 0) {
      lines.push(`    ${line}`);
    } else {
      lines.push("");
    }
  }
  return lines;
};

export const formatHubReadinessCheckLines = (
  report: HubReadinessCheckReport,
): readonly string[] => {
  const lines = ["Hub readiness check"];
  for (const section of report.sections) {
    lines.push("", section.title);
    for (const finding of section.findings) {
      lines.push(...formatFindingLines(finding));
    }
  }
  lines.push("");
  lines.push(summarizeReport(report));
  return lines;
};
