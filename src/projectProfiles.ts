export interface ProjectProfileEntry {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /**
   * Dockerfile/Containerfile fragment composed after backlog manager tools.
   * Empty for profiles that do not add language-specific image layers.
   */
  readonly containerfileTools: string;
  /** Content written to `.sandcastle/bootstrap.sh` during init. */
  readonly bootstrapScript: string;
}

const GENERIC_BOOTSTRAP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

# Sandcastle repository bootstrap — customize for your stack.
# Generated as a no-op; runs from sandbox.onSandboxReady after the worktree is mounted.

exit 0
`;

const GENERIC_PROJECT_PROFILE: ProjectProfileEntry = {
  name: "generic",
  label: "Generic",
  description:
    "Language-agnostic scaffold with a no-op bootstrap script you can customize",
  containerfileTools: "",
  bootstrapScript: GENERIC_BOOTSTRAP_SCRIPT,
};

export const DEFAULT_PROJECT_PROFILE = GENERIC_PROJECT_PROFILE;
export const DEFAULT_PROJECT_PROFILE_NAME = GENERIC_PROJECT_PROFILE.name;

const PROJECT_PROFILE_REGISTRY: readonly ProjectProfileEntry[] = [
  GENERIC_PROJECT_PROFILE,
];

export const listProjectProfiles = (): readonly ProjectProfileEntry[] =>
  PROJECT_PROFILE_REGISTRY;

export const getProjectProfile = (
  name: string,
): ProjectProfileEntry | undefined =>
  PROJECT_PROFILE_REGISTRY.find((profile) => profile.name === name);
