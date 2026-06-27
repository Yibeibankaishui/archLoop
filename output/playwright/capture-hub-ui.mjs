import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(
  "/Users/yibeibankaishui/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/",
);
const { chromium } = require("playwright");

const repoRoot = "/Users/yibeibankaishui/projects/ref/sandcastle";
const outDir = path.join(repoRoot, "output/playwright");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

const consoleMessages = [];
const pageErrors = [];
const requestsFailed = [];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
];
const sections = [
  { name: "overview", label: /Project Overview/ },
  { name: "task-board", label: /Task Board/ },
  { name: "run-workbench", label: /Run Workbench/ },
  { name: "proposal-session", label: /Proposal Session/ },
];

const results = [];

for (const viewport of viewports) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
  });

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleMessages.push({
        viewport: viewport.name,
        type: message.type(),
        text: message.text(),
      });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push({ viewport: viewport.name, text: error.message });
  });
  page.on("requestfailed", (request) => {
    requestsFailed.push({
      viewport: viewport.name,
      url: request.url(),
      failure: request.failure()?.errorText,
    });
  });

  await page.goto("http://127.0.0.1:5174/", { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  if (viewport.width < 760) {
    const initialDrawer = page.locator(".hub-drawer");
    if (await initialDrawer.isVisible()) {
      const screenshot = path.join(
        outDir,
        `hub-initial-inspector-drawer-${viewport.name}.png`,
      );
      await page.screenshot({ path: screenshot, fullPage: false });
      results.push({
        viewport,
        section: "initial-inspector-drawer",
        screenshot,
        metrics: {
          note: "Inspector drawer is open on initial narrow viewport load.",
        },
      });
      await page.locator(".hub-drawer .hub-inspector-close").click();
      await page.waitForTimeout(300);
    }
  }

  for (const [index, section] of sections.entries()) {
    if (index > 0) {
      await page.getByRole("button", { name: section.label }).first().click();
      await page.waitForTimeout(500);
    }

    const screenshot = path.join(
      outDir,
      `hub-${section.name}-${viewport.name}.png`,
    );
    await page.screenshot({ path: screenshot, fullPage: false });

    const metrics = await page.evaluate(() => {
      const elementMetrics = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return undefined;
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
        };
      };

      const buttons = Array.from(document.querySelectorAll("button")).map(
        (button) => {
          const rect = button.getBoundingClientRect();
          return {
            text: (button.textContent || "").replace(/\s+/g, " ").trim(),
            aria: button.getAttribute("aria-label") || "",
            title: button.getAttribute("title") || "",
            disabled:
              button.disabled || button.getAttribute("aria-disabled") === "true",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        },
      );

      const headings = Array.from(document.querySelectorAll("h1,h2,strong"))
        .slice(0, 100)
        .map((element) =>
          (element.textContent || "").replace(/\s+/g, " ").trim(),
        )
        .filter(Boolean);

      const overflowElements = Array.from(document.querySelectorAll("body *"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.right > window.innerWidth + 1 || rect.left < -1)
          );
        })
        .slice(0, 25)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            className: element.className?.toString?.() || element.tagName,
            text: (element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        });

      return {
        title: document.querySelector("h1")?.textContent || "",
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        root: elementMetrics("#root"),
        shell: elementMetrics(".hub-shell"),
        header: elementMetrics(".hub-header"),
        rail: elementMetrics(".hub-rail"),
        main: elementMetrics(".hub-main"),
        inspector: elementMetrics(".hub-inspector, .hub-drawer"),
        buttons,
        disabledButtonCount: buttons.filter((button) => button.disabled).length,
        buttonCount: buttons.length,
        headings,
        overflowElements,
      };
    });

    results.push({
      viewport,
      section: section.name,
      screenshot,
      metrics,
    });
  }

  await page.close();
}

await browser.close();

const summaryPath = path.join(outDir, "hub-ui-qa-summary.json");
await writeFile(
  summaryPath,
  JSON.stringify(
    { results, consoleMessages, pageErrors, requestsFailed },
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      summaryPath,
      screenshots: results.map((result) => result.screenshot),
      consoleMessages,
      pageErrors,
      requestsFailed,
    },
    null,
    2,
  ),
);
