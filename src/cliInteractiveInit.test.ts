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
const mockExecSync = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

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
import { RUNTIME_DEBUG_ADDON_ID } from "./capabilityPacks.js";

describe("sandcastle init interactive runtime selection", () => {
  let hostDir: string;
  let originalCwd: string;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    hostDir = await mkdtemp(join(tmpdir(), "cli-interactive-init-"));
    process.env.XDG_DATA_HOME = join(hostDir, "data");
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
        if (opts.message === "Select a capability pack:") {
          return "generic";
        }
        if (opts.message === "Select a template:") {
          return "blank";
        }
        if (opts.message === "Select a project profile:") {
          expect(opts.initialValue).toBe("generic");
          return "generic";
        }
        if (opts.message === "Set up Cursor authentication now?") {
          return "env";
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
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    vi.clearAllMocks();
  });

  it("asks for project profile after template selection", async () => {
    const selectOrder: string[] = [];
    mockSelect.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        selectOrder.push(opts.message);
        if (opts.message === "Select the default scaffold agent:")
          return "cursor";
        if (opts.message === "Select a sandbox provider:") return "docker";
        if (opts.message === "Select a backlog manager:") return "beads";
        if (opts.message === "Select a capability pack:") return "generic";
        if (opts.message === "Select a template:") return "simple-loop";
        if (opts.message === "Select a project profile:") {
          expect(opts.initialValue).toBe("generic");
          return "generic";
        }
        if (opts.message === "Set up Cursor authentication now?") return "env";
        throw new Error(`Unexpected select prompt: ${opts.message}`);
      },
    );
    mockMultiselect.mockResolvedValue(["cursor"]);
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Create a "Sandcastle" GitHub label?'))
        return false;
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "sandcastle", "init"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
      }),
    );

    const templateIndex = selectOrder.indexOf("Select a template:");
    const profileIndex = selectOrder.indexOf("Select a project profile:");
    expect(templateIndex).toBeGreaterThanOrEqual(0);
    expect(profileIndex).toBeGreaterThan(templateIndex);

    const bootstrap = await readFile(
      join(hostDir, ".sandcastle", "bootstrap.sh"),
      "utf-8",
    );
    expect(bootstrap).toContain("exit 0");
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

  it("only offers env or skip for Cursor auth setup", async () => {
    mockSelect.mockImplementation(
      async (opts: {
        message: string;
        options?: Array<{ value: string; label: string }>;
      }) => {
        if (opts.message === "Select the default scaffold agent:")
          return "cursor";
        if (opts.message === "Select a sandbox provider:") return "docker";
        if (opts.message === "Select a backlog manager:") return "beads";
        if (opts.message === "Select a capability pack:") return "generic";
        if (opts.message === "Select a template:") return "blank";
        if (opts.message === "Select a project profile:") return "generic";
        if (opts.message === "Set up Cursor authentication now?") {
          expect(opts.options).toEqual([
            {
              value: "env",
              label: "Use CURSOR_API_KEY in .sandcastle/.env",
            },
            {
              value: "skip",
              label: "Skip for now",
            },
          ]);
          return "skip";
        }
        throw new Error(`Unexpected select prompt: ${opts.message}`);
      },
    );
    mockMultiselect.mockResolvedValue(["cursor"]);
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "sandcastle", "init"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
      }),
    );
  });

  it("offers GitHub auth setup and supports the GH_TOKEN env path", async () => {
    mockSelect.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "Select the default scaffold agent:") return "codex";
      if (opts.message === "Select a sandbox provider:") return "docker";
      if (opts.message === "Select a backlog manager:") return "github-issues";
      if (opts.message === "Select a capability pack:") return "generic";
      if (opts.message === "Select a template:") return "blank";
      if (opts.message === "Select a project profile:") return "generic";
      if (opts.message === "Set up GitHub authentication now?") return "env";
      if (opts.message === "Set up Codex authentication now?") return "env";
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockMultiselect.mockResolvedValue(["codex"]);
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Create a "Sandcastle" GitHub label?'))
        return false;
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

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

    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("gh auth login"),
      expect.anything(),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        message: expect.stringContaining("Add GH_TOKEN to .sandcastle/.env"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "Add GH_TOKEN to .sandcastle/.env before running GitHub Issues templates.",
        ),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        message: expect.stringContaining("Add OPENAI_KEY to .sandcastle/.env"),
      }),
    );
  });

  it("runs gh auth login and codex login when those login paths are selected", async () => {
    mockSelect.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "Select the default scaffold agent:") return "codex";
      if (opts.message === "Select a sandbox provider:") return "docker";
      if (opts.message === "Select a backlog manager:") return "github-issues";
      if (opts.message === "Select a capability pack:") return "generic";
      if (opts.message === "Select a template:") return "blank";
      if (opts.message === "Select a project profile:") return "generic";
      if (opts.message === "Set up GitHub authentication now?") return "login";
      if (opts.message === "Set up Codex authentication now?") return "login";
      if (opts.message === "Set up Cursor authentication now?") return "skip";
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockMultiselect.mockResolvedValue(["codex", "cursor"]);
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Create a "Sandcastle" GitHub label?'))
        return false;
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

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

    expect(mockExecSync).toHaveBeenCalledWith(
      "gh auth login --insecure-storage",
      expect.objectContaining({
        env: expect.objectContaining({
          GH_CONFIG_DIR: expect.stringContaining(
            join("sandcastle", "hub", "auth", "github"),
          ),
        }),
      }),
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      "codex login",
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: expect.stringContaining(
            join("sandcastle", "hub", "auth", "codex"),
          ),
        }),
      }),
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      "agent login",
      expect.anything(),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining("Run `npm run sandcastle`"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        severity: "warn",
        message: expect.stringContaining(
          "Set CURSOR_API_KEY before the first Cursor sandbox run",
        ),
      }),
    );
  });

  it("supports skipping GitHub auth setup", async () => {
    mockSelect.mockImplementation(async (opts: { message: string }) => {
      if (opts.message === "Select the default scaffold agent:") return "codex";
      if (opts.message === "Select a sandbox provider:") return "docker";
      if (opts.message === "Select a backlog manager:") return "github-issues";
      if (opts.message === "Select a capability pack:") return "generic";
      if (opts.message === "Select a template:") return "blank";
      if (opts.message === "Select a project profile:") return "generic";
      if (opts.message === "Set up GitHub authentication now?") return "skip";
      if (opts.message === "Set up Codex authentication now?") return "skip";
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockMultiselect.mockResolvedValue(["codex"]);
    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Create a "Sandcastle" GitHub label?'))
        return false;
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

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

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "status",
        message: expect.stringContaining("Skipped GitHub auth setup"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "Set up GitHub auth later with GH_TOKEN in .sandcastle/.env",
        ),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "Set up Codex auth later with OPENAI_KEY in .sandcastle/.env",
        ),
      }),
    );
  });

  it("scripted init with github-issues skips the interactive auth prompt and appends next steps", async () => {
    mockSelect.mockImplementation(async (opts: { message: string }) => {
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockExecSync.mockImplementation(() => undefined);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli([
          "node",
          "sandcastle",
          "init",
          "--agent",
          "codex",
          "--runtimes",
          "codex",
          "--sandbox",
          "docker",
          "--backlog",
          "github-issues",
          "--template",
          "blank",
          "--preset-agents",
          "none",
          "--create-sandcastle-label",
          "false",
          "--build-image",
          "false",
        ]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );

    expect(mockExecSync).not.toHaveBeenCalledWith(
      "gh auth login",
      expect.anything(),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "This scripted init skipped interactive GitHub auth setup.",
        ),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "This scripted init skipped interactive Codex auth setup.",
        ),
      }),
    );
  });

  it("scripted init with cursor runtime includes explicit cursor auth next steps", async () => {
    mockSelect.mockImplementation(async (opts: { message: string }) => {
      throw new Error(`Unexpected select prompt: ${opts.message}`);
    });
    mockExecSync.mockImplementation(() => undefined);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli([
          "node",
          "sandcastle",
          "init",
          "--agent",
          "cursor",
          "--runtimes",
          "cursor",
          "--sandbox",
          "docker",
          "--backlog",
          "beads",
          "--template",
          "blank",
          "--preset-agents",
          "none",
          "--build-image",
          "false",
        ]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
        return yield* Ref.get(ref);
      }),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining(
          "This scripted init skipped interactive Cursor auth setup.",
        ),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining("bootstrap will fail"),
      }),
    );
    expect(entries).not.toContainEqual(
      expect.objectContaining({
        _tag: "text",
        message: expect.stringContaining("CURSOR_CONFIG_DIR"),
      }),
    );
  });
});

describe("sandcastle init interactive capability add-ons", () => {
  let hostDir: string;
  let originalCwd: string;
  let originalXdgDataHome: string | undefined;

  const runMiniprogramInteractiveInit = async (options: {
    sandbox: "docker" | "no-sandbox";
    addonSelection: readonly string[];
    backlog?: "beads" | "github-issues";
  }) => {
    const backlog =
      options.backlog ??
      (options.sandbox === "no-sandbox" ? "github-issues" : "beads");
    mockSelect.mockImplementation(
      async (opts: { message: string; initialValue?: string }) => {
        if (opts.message === "Select the default scaffold agent:")
          return "cursor";
        if (opts.message === "Select a sandbox provider:")
          return options.sandbox;
        if (opts.message === "Select a backlog manager:") return backlog;
        if (opts.message === "Select a capability pack:") return "miniprogram";
        if (opts.message === "Select a template:")
          return "parallel-planner-with-review";
        if (opts.message === "Select a project profile:") return "node";
        if (opts.message === "Set up GitHub authentication now?") return "skip";
        if (opts.message === "Set up Cursor authentication now?") return "skip";
        throw new Error(`Unexpected select prompt: ${opts.message}`);
      },
    );

    mockMultiselect.mockImplementation(
      async (opts: { message: string; options?: unknown[] }) => {
        if (opts.message.includes("Select agent runtimes")) {
          return ["cursor"];
        }
        if (opts.message === "Select capability add-ons (optional):") {
          return [...options.addonSelection];
        }
        throw new Error(`Unexpected multiselect prompt: ${opts.message}`);
      },
    );

    mockConfirm.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Create a "Sandcastle" GitHub label?'))
        return false;
      if (opts.message.startsWith("Add preset agent roles")) return false;
      if (opts.message.startsWith("Build the default Docker image now"))
        return false;
      if (
        opts.message.startsWith(
          "Install project-local miniprogram-ci as a dev dependency",
        )
      ) {
        return false;
      }
      throw new Error(`Unexpected confirm prompt: ${opts.message}`);
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* Ref.make<ReadonlyArray<DisplayEntry>>([]);
        yield* cli(["node", "sandcastle", "init"]).pipe(
          Effect.provide(SilentDisplay.layer(ref)),
          Effect.provide(NodeContext.layer),
        );
      }),
    );
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    hostDir = await mkdtemp(
      join(tmpdir(), "cli-interactive-capability-addons-"),
    );
    process.env.XDG_DATA_HOME = join(hostDir, "data");
    process.chdir(hostDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    }
    vi.clearAllMocks();
  });

  it("offers runtime-debug when miniprogram and no-sandbox are selected", async () => {
    await runMiniprogramInteractiveInit({
      sandbox: "no-sandbox",
      addonSelection: [RUNTIME_DEBUG_ADDON_ID],
    });

    const addonPromptCall = mockMultiselect.mock.calls.find(
      ([args]) =>
        (args as { message: string }).message ===
        "Select capability add-ons (optional):",
    );
    expect(addonPromptCall?.[0]).toEqual(
      expect.objectContaining({
        message: "Select capability add-ons (optional):",
        options: [
          expect.objectContaining({
            value: RUNTIME_DEBUG_ADDON_ID,
            hint: expect.stringContaining("no-sandbox"),
          }),
        ],
        required: false,
      }),
    );

    const runtimeDebugContext = await readFile(
      join(hostDir, ".sandcastle", "context", "miniprogram-runtime-debug.md"),
      "utf-8",
    );
    expect(runtimeDebugContext).toContain("WaterTian");
    expect(runtimeDebugContext).toMatch(/does not replace.*verify\.sh/is);

    const manifest = JSON.parse(
      await readFile(join(hostDir, ".sandcastle", "capability.json"), "utf-8"),
    ) as { addons: string[] };
    expect(manifest.addons).toEqual([RUNTIME_DEBUG_ADDON_ID]);
  });

  it("shows runtime-debug disabled with docker sandbox and skips context", async () => {
    await runMiniprogramInteractiveInit({
      sandbox: "docker",
      addonSelection: [],
    });

    const addonPromptCall = mockMultiselect.mock.calls.find(
      ([args]) =>
        (args as { message: string }).message ===
        "Select capability add-ons (optional):",
    );
    expect(addonPromptCall?.[0]).toEqual(
      expect.objectContaining({
        message: "Select capability add-ons (optional):",
        options: [
          expect.objectContaining({
            value: RUNTIME_DEBUG_ADDON_ID,
            disabled: true,
            hint: expect.stringMatching(
              /Unavailable with "docker" sandbox.*no-sandbox/i,
            ),
          }),
        ],
      }),
    );

    await expect(
      readFile(
        join(hostDir, ".sandcastle", "context", "miniprogram-runtime-debug.md"),
        "utf-8",
      ),
    ).rejects.toThrow();
  });
});
