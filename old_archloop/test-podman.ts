import * as archloop from "@yibeibankaishui/archloop";
import { podman } from "@yibeibankaishui/archloop/sandboxes/podman";

const { commits, branch } = await archloop.run({
  sandbox: podman(),
  name: "Test",
  agent: archloop.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
