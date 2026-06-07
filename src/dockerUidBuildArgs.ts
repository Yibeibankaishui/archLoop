/** Default `agent` user UID/GID baked into Dockerfile templates when host UID is unavailable or root. */
export const DEFAULT_AGENT_UID = 1000;
export const DEFAULT_AGENT_GID = DEFAULT_AGENT_UID;

const DOCKER_SANDBOX_PROVIDER_CALL = /const sandboxProvider = docker\(\{\n/;

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
export const ROOT_HOST_DOCKER_UID_GUIDANCE =
  `Running as root (UID 0). The image is built with AGENT_UID=${DEFAULT_AGENT_UID} and AGENT_GID=${DEFAULT_AGENT_GID} ` +
  `(UID 0 is reserved for root inside the image and cannot be used for the agent user). ` +
  `Pass containerUid: ${DEFAULT_AGENT_UID} and containerGid: ${DEFAULT_AGENT_GID} to docker() so the runtime user matches the image.`;

/** Lines injected into scaffolded `main.mts` when init runs as root on Docker. */
export const dockerRootRuntimeUidSnippet = (): string =>
  `  containerUid: ${DEFAULT_AGENT_UID},\n  containerGid: ${DEFAULT_AGENT_GID},`;

/** Add `containerUid` / `containerGid` to generated docker() calls when the host is root. */
export const injectDockerRootRuntimeUid = (
  mainContent: string,
  hostUid: number | undefined = process.getuid?.(),
): string => {
  if (hostUid !== 0 || mainContent.includes("containerUid:")) {
    return mainContent;
  }
  return mainContent.replace(
    DOCKER_SANDBOX_PROVIDER_CALL,
    `const sandboxProvider = docker({\n${dockerRootRuntimeUidSnippet()}\n`,
  );
};

export const buildDockerRootHostNextStepLines = (
  sandboxProviderName: string,
  hostUid: number | undefined = process.getuid?.(),
): string[] => {
  if (sandboxProviderName !== "docker" || hostUid !== 0) {
    return [];
  }
  return [ROOT_HOST_DOCKER_UID_GUIDANCE];
};

/** Extra hint appended to Docker UID mismatch errors when the host runs as root. */
export const dockerUidMismatchRootHint = (imageUid: number): string =>
  ` On WSL2/root (host UID 0), pass containerUid: ${imageUid} and containerGid: ${imageUid} to docker() — init scaffolds these when run as root.`;
