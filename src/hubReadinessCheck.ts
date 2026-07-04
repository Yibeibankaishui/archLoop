import { execSync } from "node:child_process";

import { listAgents } from "./InitService.js";
import { formatMissingAgentCredentialsMessage } from "./agentAuthGuidance.js";
import {
  formatMissingHubAgentRolesMessage,
  listMissingHubAgentRoles,
  readHubAgentConfig,
  validateHubAgentRoleEntry,
  type HubAgentRoleEntry,
} from "./hubAgentConfig.js";
import { resolveHubAuthSessionEnv } from "./hubAuth.js";
import { resolveHubEnv } from "./hubEnv.js";

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
}

interface ProviderReference {
  readonly provider: string;
  readonly model: string;
  readonly roles: readonly string[];
}

const providerToolCommands: Readonly<Record<string, string | undefined>> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "agent",
  opencode: "opencode",
  pi: "pi",
};

const normalizeOptionsKey = (
  options: HubAgentRoleEntry["options"],
): string | undefined => {
  if (!options) {
    return undefined;
  }

  const entries = Object.entries(options)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? JSON.stringify(entries) : undefined;
};

const formatProviderReference = (reference: ProviderReference): string => {
  const roles = reference.roles.join(", ");
  const model = reference.model.length > 0 ? ` / ${reference.model}` : "";
  return `${roles}: ${reference.provider}${model}`;
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

  return { missingRoles, validEntries, errors };
};

const collectProviderReferences = (
  validEntries: readonly { role: string; entry: HubAgentRoleEntry }[],
): readonly ProviderReference[] => {
  const references = new Map<string, ProviderReference>();

  for (const { role, entry } of validEntries) {
    const key = [
      entry.provider,
      entry.model,
      normalizeOptionsKey(entry.options) ?? "",
    ].join("::");
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
    });
  }

  return [...references.values()].sort((left, right) =>
    formatProviderReference(left).localeCompare(formatProviderReference(right)),
  );
};

const collectCredentialFindings = (
  references: readonly ProviderReference[],
  options: HubReadinessCheckOptions,
): HubReadinessFinding[] => {
  const runtimeEnv = options.env ?? process.env;
  const hubEnv = resolveHubEnv({ env: runtimeEnv, homeDir: options.homeDir });
  const hubAuthEnv = resolveHubAuthSessionEnv({
    env: runtimeEnv,
    homeDir: options.homeDir,
  });

  const findings: HubReadinessFinding[] = [];
  for (const reference of references) {
    const providerLabel = resolveProviderLabel(reference.provider);

    const envKeys =
      reference.provider === "claude-code"
        ? ["ANTHROPIC_API_KEY"]
        : reference.provider === "codex"
          ? ["OPENAI_KEY"]
          : reference.provider === "cursor"
            ? ["CURSOR_API_KEY"]
            : reference.provider === "opencode"
              ? ["OPENCODE_API_KEY"]
              : reference.provider === "pi"
                ? ["ANTHROPIC_API_KEY"]
                : [];

    const authEnvKey =
      reference.provider === "codex"
        ? "CODEX_HOME"
        : reference.provider === "github"
          ? "GH_CONFIG_DIR"
          : undefined;

    const envSatisfied = envKeys.some((key) => {
      const value = hubEnv[key] ?? runtimeEnv[key] ?? "";
      return value.trim().length > 0;
    });
    const authSatisfied =
      authEnvKey !== undefined &&
      ((hubAuthEnv[authEnvKey] ?? runtimeEnv[authEnvKey] ?? "").trim().length >
        0);

    if (envSatisfied || authSatisfied) {
      findings.push({
        severity: "success",
        title: `${providerLabel} credentials`,
        message: `${formatProviderReference(reference)} has a configured credential source.`,
      });
      continue;
    }

    const missingEnvKey = envKeys[0];
    findings.push({
      severity: "error",
      title: `${providerLabel} credentials`,
      message:
        missingEnvKey !== undefined
          ? formatMissingAgentCredentialsMessage({
              providerName: reference.provider,
              envKey: missingEnvKey,
              label: providerLabel,
            })
          : `Hub agent provider "${reference.provider}" does not expose a credential key.`,
    });
  }

  return findings;
};

const collectToolFindings = (
  references: readonly ProviderReference[],
  options: HubReadinessCheckOptions,
): HubReadinessFinding[] => {
  const runtimeEnv = options.env ?? process.env;
  const findings: HubReadinessFinding[] = [];

  for (const reference of references) {
    const command = providerToolCommands[reference.provider];
    const providerLabel = resolveProviderLabel(reference.provider);

    if (!command) {
      findings.push({
        severity: "error",
        title: `${providerLabel} tool`,
        message: `Hub agent provider "${reference.provider}" does not map to a known CLI command.`,
      });
      continue;
    }

    if (!commandExists(command, runtimeEnv)) {
      findings.push({
        severity: "error",
        title: `${providerLabel} tool`,
        message: `Provider CLI "${command}" is not available on PATH for ${formatProviderReference(reference)}.`,
      });
      continue;
    }

    findings.push({
      severity: "success",
      title: `${providerLabel} tool`,
      message: `Found provider CLI "${command}" for ${formatProviderReference(reference)}.`,
    });
  }

  return findings;
};

const buildSmokeWarningSection = (): HubReadinessSection => ({
  title: "Checking provider/model smoke",
  findings: [
    {
      severity: "warn",
      title: "Provider/model smoke checks",
      message:
        "Provider/model smoke checks are deferred in this arch-ua6 slice; no provider calls were made yet.",
    },
  ],
});

export const collectHubReadinessChecks = (
  options: HubReadinessCheckOptions = {},
): HubReadinessCheckReport => {
  const config = readHubAgentConfig(options);
  const roleCheck = readRoleEntries(config);

  if (roleCheck.errors.length > 0) {
    return {
      sections: [
        {
          title: "Checking Hub agent roles",
          findings: roleCheck.errors,
        },
      ],
      hasWarnings: false,
      hasErrors: true,
    };
  }

  const references = collectProviderReferences(roleCheck.validEntries);
  const roleSuccessFindings =
    references.length > 0
      ? [
          {
            severity: "success" as const,
            title: "Hub agent roles",
            message:
              "All required Hub agent roles are configured and validated.",
          },
        ]
      : [
          {
            severity: "success" as const,
            title: "Hub agent roles",
            message: "No Hub agent roles are configured.",
          },
        ];

  const sections: HubReadinessSection[] = [
    {
      title: "Checking Hub agent roles",
      findings: roleSuccessFindings,
    },
  ];

  if (references.length > 0) {
    sections.push({
      title: "Checking configured provider references",
      findings: references.map((reference) => ({
        severity: "success" as const,
        title: `${resolveProviderLabel(reference.provider)} reference`,
        message: formatProviderReference(reference),
      })),
    });
    sections.push({
      title: "Checking Hub env and auth",
      findings: collectCredentialFindings(references, options),
    });
    sections.push({
      title: "Checking required tools",
      findings: collectToolFindings(references, options),
    });
  }

  sections.push(buildSmokeWarningSection());

  const hasWarnings = sections.some((section) =>
    section.findings.some((finding) => finding.severity === "warn"),
  );
  const hasErrors = sections.some((section) =>
    section.findings.some((finding) => finding.severity === "error"),
  );

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
  lines.push(
    report.hasErrors
      ? "Hub readiness check failed."
      : report.hasWarnings
        ? "Hub readiness check completed with warnings."
        : "Hub readiness check passed.",
  );
  return lines;
};
