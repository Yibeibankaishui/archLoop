import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GID,
  DEFAULT_AGENT_UID,
  buildDockerRootHostNextStepLines,
  injectDockerRootRuntimeUid,
  resolveDockerUidBuildArgs,
  ROOT_HOST_DOCKER_UID_GUIDANCE,
} from "./dockerUidBuildArgs.js";

describe("resolveDockerUidBuildArgs", () => {
  it("maps host UID/GID 0 to default agent UID/GID 1000", () => {
    const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs(
      () => 0,
      () => 0,
    );

    expect(buildArgs).toEqual({
      AGENT_UID: String(DEFAULT_AGENT_UID),
      AGENT_GID: String(DEFAULT_AGENT_GID),
    });
    expect(hostIsRoot).toBe(true);
  });

  it("passes through non-root host UID/GID unchanged", () => {
    const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs(
      () => 1001,
      () => 1002,
    );

    expect(buildArgs).toEqual({ AGENT_UID: "1001", AGENT_GID: "1002" });
    expect(hostIsRoot).toBe(false);
  });

  it("returns no build args when getuid/getgid are unavailable (Windows)", () => {
    const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs(
      () => undefined,
      () => undefined,
    );

    expect(buildArgs).toEqual({});
    expect(hostIsRoot).toBe(false);
  });

  it("maps only GID 0 when UID is non-zero", () => {
    const { buildArgs, hostIsRoot } = resolveDockerUidBuildArgs(
      () => 501,
      () => 0,
    );

    expect(buildArgs).toEqual({
      AGENT_UID: "501",
      AGENT_GID: String(DEFAULT_AGENT_GID),
    });
    expect(hostIsRoot).toBe(false);
  });
});

describe("ROOT_HOST_DOCKER_UID_GUIDANCE", () => {
  it("mentions containerUid/containerGid and the image build UID", () => {
    expect(ROOT_HOST_DOCKER_UID_GUIDANCE).toContain("containerUid");
    expect(ROOT_HOST_DOCKER_UID_GUIDANCE).toContain("containerGid");
    expect(ROOT_HOST_DOCKER_UID_GUIDANCE).toContain(String(DEFAULT_AGENT_UID));
  });
});

describe("injectDockerRootRuntimeUid", () => {
  const sample = `const sandboxProvider = docker({
  mounts: [],
});`;

  it("injects containerUid and containerGid when host UID is 0", () => {
    const updated = injectDockerRootRuntimeUid(sample, 0);
    expect(updated).toContain("containerUid: 1000");
    expect(updated).toContain("containerGid: 1000");
  });

  it("leaves content unchanged for non-root hosts", () => {
    expect(injectDockerRootRuntimeUid(sample, 1001)).toBe(sample);
  });

  it("does not double-inject when containerUid is already present", () => {
    const withUid = `const sandboxProvider = docker({
  containerUid: 1000,
  containerGid: 1000,
  mounts: [],
});`;
    expect(injectDockerRootRuntimeUid(withUid, 0)).toBe(withUid);
  });
});

describe("buildDockerRootHostNextStepLines", () => {
  it("returns WSL/root guidance for docker when host UID is 0", () => {
    const lines = buildDockerRootHostNextStepLines("docker", 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("containerUid");
  });

  it("returns nothing for podman or non-root hosts", () => {
    expect(buildDockerRootHostNextStepLines("docker", 1000)).toEqual([]);
    expect(buildDockerRootHostNextStepLines("no-sandbox", 0)).toEqual([]);
  });
});
