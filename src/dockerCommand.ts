import { existsSync } from "node:fs";

/**
 * Resolve the docker CLI binary.
 *
 * Priority:
 * 1) SANDCASTLE_DOCKER_BIN override
 * 2) `docker` from PATH
 * 3) macOS Docker Desktop bundled CLI path
 */
export const dockerCommand = (): string => {
  const override = process.env.SANDCASTLE_DOCKER_BIN?.trim();
  if (override) return override;

  const macDockerDesktop =
    "/Applications/Docker.app/Contents/Resources/bin/docker";
  if (process.platform === "darwin" && existsSync(macDockerDesktop)) {
    return macDockerDesktop;
  }

  return "docker";
};
