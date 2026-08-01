import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsRoot = path.join(projectRoot, "docs", "content", "docs");

const requiredFiles = [
  "README.md",
  "readme_cn.md",
  "user_guide.md",
  "skills/archloop-usage/SKILL.md",
  "docs/content/docs/index.mdx",
  "docs/content/docs/getting-started/index.mdx",
  "docs/content/docs/concepts/index.mdx",
  "docs/content/docs/guides/index.mdx",
  "docs/content/docs/cli/index.mdx",
  "docs/content/docs/api/index.mdx",
  "docs/content/docs/reference/index.mdx",
  "docs/content/docs/reference/troubleshooting.mdx",
  "docs/content/docs/contributing/documentation.mdx",
];

const quickStartFiles = [
  "README.md",
  "readme_cn.md",
  "docs/content/docs/index.mdx",
  "docs/content/docs/getting-started/index.mdx",
];

const canonicalQuickStart = [
  "npm install --save-dev @yibeibankaishui/archloop",
  "npx archloop initialize",
  "npx archloop project add",
  "npx archloop check",
  "npx archloop run --flow with-review",
];

const publicEntryFiles = [
  "README.md",
  "readme_cn.md",
  "user_guide.md",
  "skills/archloop-usage/SKILL.md",
];

const failures = [];

const relative = (absolutePath) => path.relative(projectRoot, absolutePath);

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : [target];
    }),
  );
  return nested.flat();
};

for (const file of requiredFiles) {
  if (!(await pathExists(path.join(projectRoot, file)))) {
    failures.push(`missing required documentation file: ${file}`);
  }
}

const siteFiles = (await walk(docsRoot)).filter((file) =>
  [".md", ".mdx", ".json"].includes(path.extname(file)),
);
const contentFiles = [
  ...publicEntryFiles.map((file) => path.join(projectRoot, file)),
  ...siteFiles.filter((file) => [".md", ".mdx"].includes(path.extname(file))),
];

const contentByFile = new Map();
for (const file of contentFiles) {
  contentByFile.set(file, await readFile(file, "utf8"));
}

for (const file of quickStartFiles) {
  const content = await readFile(path.join(projectRoot, file), "utf8");
  let previousIndex = -1;
  for (const command of canonicalQuickStart) {
    const currentIndex = content.indexOf(command);
    if (currentIndex === -1) {
      failures.push(`${file}: canonical quick start is missing \`${command}\``);
      continue;
    }
    if (currentIndex < previousIndex) {
      failures.push(`${file}: canonical quick-start commands are out of order`);
      break;
    }
    previousIndex = currentIndex;
  }
}

const lineLimits = new Map([
  ["README.md", 350],
  ["readme_cn.md", 350],
  ["skills/archloop-usage/SKILL.md", 500],
]);

for (const [file, maximum] of lineLimits) {
  const content = await readFile(path.join(projectRoot, file), "utf8");
  const lines = content.split(/\r?\n/).length;
  if (lines > maximum) {
    failures.push(`${file}: ${lines} lines exceeds the ${maximum}-line limit`);
  }
}

const forbiddenPatterns = [
  [/@ai-hero\/sandcastle|\.sandcastle\/|SANDCASTLE_/i, "old product identity"],
  [/\bnpm install -g archloop\b/i, "obsolete global installation command"],
  [/(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//, "personal absolute path"],
  [/[A-Za-z]:\\Users\\[^\\\s]+\\/, "personal Windows path"],
];

for (const [file, content] of contentByFile) {
  for (const [pattern, description] of forbiddenPatterns) {
    if (pattern.test(content)) {
      failures.push(`${relative(file)}: contains ${description}`);
    }
  }
}

const userGuide = await readFile(
  path.join(projectRoot, "user_guide.md"),
  "utf8",
);
if (
  !userGuide.includes("## 文档修改记录") ||
  !userGuide.includes("2026-08-01")
) {
  failures.push(
    "user_guide.md: missing the current documentation change record",
  );
}

const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
for (const [file, content] of contentByFile) {
  for (const match of content.matchAll(markdownLinkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(/\s+["']/)[0].split("#")[0];
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      /^[a-z]+:/i.test(target)
    ) {
      continue;
    }
    const resolved = path.resolve(
      path.dirname(file),
      decodeURIComponent(target),
    );
    if (!(await pathExists(resolved))) {
      failures.push(`${relative(file)}: broken local link \`${match[1]}\``);
    }
  }
}

for (const file of siteFiles.filter((file) => file.endsWith(".mdx"))) {
  const content = await readFile(file, "utf8");
  if (!content.startsWith("---\n") || !/^title:\s+.+$/m.test(content)) {
    failures.push(`${relative(file)}: MDX page is missing title frontmatter`);
  }
}

for (const metaFile of siteFiles.filter((file) => file.endsWith("meta.json"))) {
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  for (const entry of meta.pages ?? []) {
    if (entry.startsWith("---")) continue;
    const directory = path.dirname(metaFile);
    const candidates = [
      path.join(directory, `${entry}.mdx`),
      path.join(directory, `${entry}.md`),
      path.join(directory, entry),
    ];
    const results = await Promise.all(candidates.map(pathExists));
    if (!results.some(Boolean)) {
      failures.push(
        `${relative(metaFile)}: navigation target \`${entry}\` does not exist`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation checks failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checks passed (${contentFiles.length} content files).`,
  );
}
