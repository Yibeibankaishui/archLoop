import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";

import { resolveEnv } from "./EnvResolver.js";

type ProviderEnvConfig = {
  readonly envKey: string;
  readonly label: string;
  readonly authEnvKeys?: readonly string[];
};

const PROVIDER_ENV_CONFIG: Readonly<
  Record<string, ProviderEnvConfig | undefined>
> = {
  cursor: { envKey: "CURSOR_API_KEY", label: "Cursor" },
  codex: {
    envKey: "OPENAI_KEY",
    label: "Codex",
    authEnvKeys: ["CODEX_HOME"],
  },
  "claude-code": {
    envKey: "ANTHROPIC_API_KEY",
    label: "Claude Code",
    authEnvKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  },
  pi: {
    envKey: "ANTHROPIC_API_KEY",
    label: "Pi",
    authEnvKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  },
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
  "claude-code": [
    /authentication/i,
    /ANTHROPIC_API_KEY/i,
    /ANTHROPIC_AUTH_TOKEN/i,
    /CLAUDE_CODE_OAUTH_TOKEN/i,
  ],
  pi: [
    /authentication/i,
    /ANTHROPIC_API_KEY/i,
    /ANTHROPIC_AUTH_TOKEN/i,
    /CLAUDE_CODE_OAUTH_TOKEN/i,
  ],
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

const buildarchLoopEnvGuidanceLines = (input: {
  readonly providerName: string;
  readonly envKey: string;
  readonly label: string;
}): readonly string[] => {
  const lines = [
    `${input.label} agent credentials are missing or invalid.`,
    "",
    "archLoop expects agent credentials in its env stores or Hub auth directories — do not rely on host-global provider login state.",
    "",
    "Fix one of:",
    "- Run `archloop env init` to set up shared Hub credentials",
    `- Run \`archloop env set ${input.envKey} <value>\` to save a credential`,
    "- Run `archloop env show` to verify configured keys",
    `- Set \`${input.envKey}\` in \`.archloop/.env\` for project sandbox runs`,
  ];

  if (input.providerName === "codex") {
    return [
      ...lines,
      "- For Codex CLI session auth: `archloop auth login codex`",
    ];
  }

  if (input.providerName === "claude-code" || input.providerName === "pi") {
    return [
      ...lines,
      "- Or set `CLAUDE_CODE_OAUTH_TOKEN` (long-lived OAuth token from `claude setup-token`) instead of `ANTHROPIC_API_KEY`",
      "- Or set `ANTHROPIC_AUTH_TOKEN` (+ `ANTHROPIC_BASE_URL`) when routing through a Claude-compatible gateway",
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
    ...buildarchLoopEnvGuidanceLines(input),
    "",
    `Original error: ${input.originalDetail.trim()}`,
  ].join("\n");

export const formatMissingAgentCredentialsMessage = (input: {
  readonly providerName: string;
  readonly envKey: string;
  readonly label: string;
}): string => buildarchLoopEnvGuidanceLines(input).join("\n");

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

  // claude-code and pi can authenticate via the claude CLI's own credential
  // store (OS keychain, internal session state, etc.) without any env var
  // archloop can observe. Skip the preflight and let the CLI handle auth;
  // if it fails, enrichAgentFailureDetail still maps the stderr to actionable
  // guidance.
  if (input.providerName === "claude-code" || input.providerName === "pi") {
    return;
  }

  const runtimeEnv = input.env ?? process.env;
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(input.cwd, { env: runtimeEnv }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  const candidateKeys = [config.envKey, ...(config.authEnvKeys ?? [])];
  const lookup = (key: string): string =>
    resolvedEnv[key]?.trim() || runtimeEnv[key]?.trim() || "";
  const value = candidateKeys.map(lookup).find((v) => v.length > 0) ?? "";

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
