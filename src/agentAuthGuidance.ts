import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

import { resolveEnv } from "./EnvResolver.js";

type ProviderEnvConfig = {
  readonly envKey: string;
  readonly label: string;
};

const PROVIDER_ENV_CONFIG: Readonly<
  Record<string, ProviderEnvConfig | undefined>
> = {
  cursor: { envKey: "CURSOR_API_KEY", label: "Cursor" },
  codex: { envKey: "OPENAI_KEY", label: "Codex" },
  "claude-code": { envKey: "ANTHROPIC_API_KEY", label: "Claude Code" },
  pi: { envKey: "ANTHROPIC_API_KEY", label: "Pi" },
  opencode: { envKey: "OPENCODE_API_KEY", label: "OpenCode" },
};

const CURSOR_TRANSPORT_PATTERNS = [
  /ECONNRESET/i,
  /secure TLS connection was established/i,
  /HTTP\/2 keepalive ping timed out/i,
] as const;

const AUTH_FAILURE_PATTERNS: Readonly<
  Record<string, readonly RegExp[] | undefined>
> = {
  cursor: [/authentication required/i, /agent login/i, /CURSOR_API_KEY/i],
  codex: [/authentication/i, /invalid api key/i, /not logged in/i, /OPENAI/i],
  "claude-code": [/authentication/i, /ANTHROPIC_API_KEY/i],
  pi: [/authentication/i, /ANTHROPIC_API_KEY/i],
  opencode: [/authentication/i, /OPENCODE_API_KEY/i],
};

const isCursorTransportFailure = (detail: string): boolean =>
  CURSOR_TRANSPORT_PATTERNS.some((pattern) => pattern.test(detail));

export const detectAgentAuthFailure = (
  providerName: string,
  detail: string,
): ProviderEnvConfig | undefined => {
  const config = PROVIDER_ENV_CONFIG[providerName];
  if (!config) return undefined;

  if (providerName === "cursor" && isCursorTransportFailure(detail)) {
    return undefined;
  }

  const patterns = AUTH_FAILURE_PATTERNS[providerName];
  if (!patterns?.some((pattern) => pattern.test(detail))) {
    return undefined;
  }

  return config;
};

const buildSandcastleEnvGuidanceLines = (input: {
  readonly providerName: string;
  readonly envKey: string;
  readonly label: string;
}): readonly string[] => {
  const lines = [
    `${input.label} agent credentials are missing or invalid.`,
    "",
    "Sandcastle expects agent credentials in its env stores — do not rely on agent login (for example `agent login` or `codex login`) for Sandcastle Hub or sandbox runs.",
    "",
    "Fix one of:",
    "- Run `sandcastle env init` to set up shared Hub credentials",
    `- Run \`sandcastle env set ${input.envKey} <value>\` to save a credential`,
    "- Run `sandcastle env show` to verify configured keys",
    `- Set \`${input.envKey}\` in \`.sandcastle/.env\` for project sandbox runs`,
  ];

  if (input.providerName === "codex") {
    return [
      ...lines,
      "- For Codex sandbox only: `CODEX_HOME=.sandcastle/auth/codex codex login`",
    ];
  }

  return lines;
};

export const formatAgentAuthFailureMessage = (input: {
  readonly providerName: string;
  readonly envKey: string;
  readonly label: string;
  readonly originalDetail: string;
}): string =>
  [
    ...buildSandcastleEnvGuidanceLines(input),
    "",
    `Original error: ${input.originalDetail.trim()}`,
  ].join("\n");

export const formatMissingAgentCredentialsMessage = (input: {
  readonly providerName: string;
  readonly envKey: string;
  readonly label: string;
}): string => buildSandcastleEnvGuidanceLines(input).join("\n");

export const enrichAgentFailureDetail = (
  providerName: string,
  detail: string,
): string => {
  const detected = detectAgentAuthFailure(providerName, detail);
  if (!detected) return detail;

  return formatAgentAuthFailureMessage({
    providerName,
    envKey: detected.envKey,
    label: detected.label,
    originalDetail: detail,
  });
};

export const assertAgentCredentialsConfigured = async (input: {
  readonly providerName: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> => {
  const config = PROVIDER_ENV_CONFIG[input.providerName];
  if (!config) return;

  const runtimeEnv = input.env ?? process.env;
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(input.cwd).pipe(Effect.provide(NodeContext.layer)),
  );

  const value =
    resolvedEnv[config.envKey]?.trim() ||
    runtimeEnv[config.envKey]?.trim() ||
    "";

  if (value.length === 0) {
    throw new Error(
      formatMissingAgentCredentialsMessage({
        providerName: input.providerName,
        envKey: config.envKey,
        label: config.label,
      }),
    );
  }
};
