import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GID,
  DEFAULT_AGENT_UID,
  resolveDockerUidBuildArgs,
  rootHostDockerUidGuidance,
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

describe("rootHostDockerUidGuidance", () => {
  it("mentions containerUid/containerGid and the image build UID", () => {
    expect(rootHostDockerUidGuidance()).toContain("containerUid");
    expect(rootHostDockerUidGuidance()).toContain("containerGid");
    expect(rootHostDockerUidGuidance()).toContain(String(DEFAULT_AGENT_UID));
  });
});
