import * as archloop from "@yibeibankaishui/archloop";
import { noSandbox } from "@yibeibankaishui/archloop/sandboxes/no-sandbox";

// /yibeibankaishui-projects/archloop
const { commits, branch } = await archloop.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: archloop.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorkspace: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
