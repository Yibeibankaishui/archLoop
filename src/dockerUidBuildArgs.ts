/** Default `agent` user UID/GID baked into Dockerfile templates when host UID is unavailable or root. */
export const DEFAULT_AGENT_UID = 1000;
export const DEFAULT_AGENT_GID = DEFAULT_AGENT_UID;

export interface DockerUidBuildArgsResult {
  readonly buildArgs: Record<string, string>;
  /** True when the host effective UID is 0 (e.g. WSL2 root). */
  readonly hostIsRoot: boolean;
}

/** Host UID/GID to Dockerfile build-arg; 0 is reserved for root and cannot be the agent user. */
const hostIdToAgentBuildArg = (
  hostId: number | undefined,
  defaultWhenZero: number,
): string | undefined => {
  if (hostId === undefined) {
    return undefined;
  }
  if (hostId === 0) {
    return String(defaultWhenZero);
  }
  return String(hostId);
};

/**
 * Build-args for `sandcastle docker build-image` that align the image agent UID/GID
 * to the host on Linux/macOS. UID/GID 0 is remapped to {@link DEFAULT_AGENT_UID}
 * because the scaffolded Dockerfile cannot assign the `node` user to UID 0.
 */
export const resolveDockerUidBuildArgs = (
  getuid: () => number | undefined = () => process.getuid?.(),
  getgid: () => number | undefined = () => process.getgid?.(),
): DockerUidBuildArgsResult => {
  const hostUid = getuid();
  const hostGid = getgid();

  const buildArgs: Record<string, string> = {};
  const agentUid = hostIdToAgentBuildArg(hostUid, DEFAULT_AGENT_UID);
  const agentGid = hostIdToAgentBuildArg(hostGid, DEFAULT_AGENT_GID);
  if (agentUid !== undefined) {
    buildArgs.AGENT_UID = agentUid;
  }
  if (agentGid !== undefined) {
    buildArgs.AGENT_GID = agentGid;
  }

  return { buildArgs, hostIsRoot: hostUid === 0 };
};

/** User-facing guidance when building as root (host UID 0). */
export const rootHostDockerUidGuidance = (): string =>
  `Running as root (UID 0). The image is built with AGENT_UID=${DEFAULT_AGENT_UID} and AGENT_GID=${DEFAULT_AGENT_GID} ` +
  `(UID 0 is reserved for root inside the image and cannot be used for the agent user). ` +
  `Pass containerUid: ${DEFAULT_AGENT_UID} and containerGid: ${DEFAULT_AGENT_GID} to docker() so the runtime user matches the image.`;
