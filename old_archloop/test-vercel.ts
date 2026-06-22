import * as archloop from "@yibeibankaishui/archloop";
import { vercel } from "@yibeibankaishui/archloop/sandboxes/vercel";

const claudeInstallHook = {
  command: "curl -fsSL https://claude.ai/install.sh | bash",
};

const ghCliInstallHook = {
  command:
    "curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo -o /etc/yum.repos.d/gh-cli.repo && dnf install -y gh",
  sudo: true,
};

// /yibeibankaishui-projects/archloop
const { commits, branch } = await archloop.run({
  sandbox: vercel({
    token: process.env.VERCEL_OIDC_TOKEN,
    teamId: "yibeibankaishui-projects",
    projectId: "archloop",
  }),
  name: "Test",
  agent: archloop.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        claudeInstallHook,
        ghCliInstallHook,
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
