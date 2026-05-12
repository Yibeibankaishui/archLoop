import { NodeContext } from "@effect/platform-node";
import { Effect, Ref } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SilentDisplay } from "./Display.js";
import type { DisplayEntry } from "./Display.js";

const mockSelect = vi.fn();
const mockMultiselect = vi.fn();
const mockConfirm = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    select: (...args: unknown[]) => mockSelect(...args),
    multiselect: (...args: unknown[]) => mockMultiselect(...args),
    confirm: (...args: unknown[]) => mockConfirm(...args),
  };
});

import { cli } from "./cli.js";

describe("sandcastle init interactive runtime selection", () => {
  let hostDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    hostDir = await mkdtemp(join(tmpdir(), "cli-interactive-init-"));
    process.chdir(hostDir);

    mockSelect.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        if (opts.message === "Select the default scaffold agent:") {
          expect(opts.initialValue).toBe("claude-code");
          return "cursor";
        }
        if (opts.message === "Select a sandbox provider:") {
          return "docker";
        }
        if (opts.message === "Select a backlog manager:") {
          return "beads";
        }
        if (opts.message === "Select a template:") {
          return "blank";
        }
        throw new Error(`Unexpected select prompt: ${opts.message}`);
      },
    );

    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith("Add preset agent roles")) {
        return false;
      }
      if (opts.message.startsWith("Build the default Docker image now")) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.clearAllMocks();
  });

  it("preselects the default agent runtime in the interactive runtime prompt", async () => {
    mockMultiselect.mockImplementation(
      async (opts: {
        message: string;
        initialValues?: string[];
        cursorAt?: string;
        required?: boolean;
        options: Array<{ value: string; hint?: string }>;
      }) => {
        expect(opts.message).toContain("Select agent runtimes");
        expect(opts.initialValues).toEqual(["cursor"]);
        expect(opts.cursorAt).toBe("cursor");
        expect(opts.required).toBe(true);
        expect(opts.options).toContainEqual(
          expect.objectContaining({
            value: "cursor",
            hint: "default selected agent",
          }),
        );
        return opts.initialValues;
      },
    );

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "sandcastle", "init"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );

    const dockerfile = await readFile(
      join(hostDir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );

    expect(mockMultiselect).toHaveBeenCalledOnce();
    expect(dockerfile).toContain("cursor.com/install");
    expect(dockerfile).not.toContain("claude.ai/install.sh");
    expect(dockerfile).not.toContain("@openai/codex");
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        message:
          "Init complete! Run `sandcastle docker build-image` to build the Docker image later.",
      }),
    );
  });
});
