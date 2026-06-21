import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  implementerAgent,
  mergerAgent,
  plannerAgent,
  reviewerAgent,
} from "./agent-config.js";

const dockerBin = existsSync(
  "/Applications/Docker.app/Contents/Resources/bin/docker",
)
  ? "/Applications/Docker.app/Contents/Resources/bin/docker"
  : "docker";

const smokeCases = [
  { name: "Planner", agent: plannerAgent, token: "PLANNER_OK" },
  { name: "Implementer", agent: implementerAgent, token: "IMPLEMENTER_OK" },
  { name: "Reviewer", agent: reviewerAgent, token: "REVIEWER_OK" },
  { name: "Merger", agent: mergerAgent, token: "MERGER_OK" },
] as const;

const runInAuthOnlyContainer = async (
  command: string,
  stdin: string | undefined,
) => {
  const args = [
    "run",
    "--rm",
    "-i",
    "--entrypoint",
    "sh",
    "-v",
    `${process.cwd()}/.archloop/auth/codex:/home/agent/.codex`,
    "-v",
    `${process.cwd()}/.archloop/auth/cursor:/home/agent/.cursor`,
    "-v",
    `${process.cwd()}/.archloop/auth/cursor-config:/home/agent/.config/cursor`,
    "-v",
    `${process.cwd()}/.archloop/auth/gh:/home/agent/.config/gh`,
    "-w",
    "/tmp",
    "archloop:archloop",
    "-lc",
    command,
  ];

  const child = spawn(dockerBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  if (stdin !== undefined) {
    child.stdin.write(stdin);
  }
  child.stdin.end();

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  return { code, stdout, stderr };
};

for (const smokeCase of smokeCases) {
  const expected = `<smoke>${smokeCase.token}</smoke>`;
  const prompt = [
    "This is a minimal provider smoke test.",
    "Do not edit files. Do not run shell commands. Do not create commits.",
    `Reply with exactly this XML tag and nothing else: ${expected}`,
  ].join("\n");

  console.log(`\n=== ${smokeCase.name} smoke test ===`);

  const printCommand = smokeCase.agent.buildPrintCommand({
    prompt,
    dangerouslySkipPermissions: false,
  });

  const result = await runInAuthOnlyContainer(
    printCommand.command,
    printCommand.stdin,
  );

  if (result.code !== 0) {
    throw new Error(
      `${smokeCase.name} exited with code ${result.code}.\n\nstderr:\n${result.stderr}`,
    );
  }

  const parsedEvents = result.stdout
    .split(/\r?\n/)
    .flatMap((line) => smokeCase.agent.parseStreamLine(line));

  const parsedText = parsedEvents
    .filter((event) => event.type === "text" || event.type === "result")
    .map((event) => ("text" in event ? event.text : event.result))
    .join("");

  if (!parsedText.includes(expected)) {
    throw new Error(
      `${smokeCase.name} did not emit ${expected}.\n\nstdout:\n${result.stdout}`,
    );
  }

  console.log(`${smokeCase.name}: ok`);
}

console.log("\nAll configured agents responded successfully.");
