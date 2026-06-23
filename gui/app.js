const runs = [
  {
    id: "issue-148",
    title: "Issue #148",
    subtitle: "planned batch selection",
    status: "waiting_for_merge",
    branch: "archloop/issue-148",
    sandbox: "docker · archloop:local",
    flow: "with-review",
    terminal: [
      ["dim", "$ npm run typecheck"],
      ["dim", "> @yibeibankaishui/archloop@0.5.9 typecheck"],
      ["dim", "> tsgo --noEmit"],
      ["ok", "✓ typecheck completed in 2.8s"],
      ["ok", "✓ source gate clean for src/"],
      ["warn", "warning: approval required before batch merge"],
    ],
    events: [
      ["ok", "09:42 batch.planned task=issue-148 strategy=planned"],
      ["ok", "09:43 lease.acquired branch=archloop/issue-148"],
      ["ok", '09:45 verification.passed command="npm run typecheck"'],
      ["warn", "09:46 merge.waiting reason=operator_approval_required"],
    ],
    patch: [
      ["dim", "diff --stat"],
      ["ok", "src/hubBatchPlanner.ts       | 28 ++++++++++++++++++++--------"],
      [
        "ok",
        "src/hubBatchPlanner.test.ts  | 46 +++++++++++++++++++++++++++++++++",
      ],
      ["dim", "2 files changed, 66 insertions(+), 8 deletions(-)"],
    ],
  },
  {
    id: "issue-147",
    title: "Issue #147",
    subtitle: "planned Hub flow batch",
    status: "failed",
    branch: "archloop/issue-147",
    sandbox: "docker · archloop:local",
    flow: "no-review",
    terminal: [
      ["dim", "$ archloop tasks recover issue-147 --dry-run"],
      ["warn", "active worktree lease found for pid 48122"],
      ["warn", "recovery blocked until the existing owner exits"],
      ["dim", "next action: wait, rerun status, then recover task"],
    ],
    events: [
      ["warn", "08:11 task.failed reason=active_lease_conflict"],
      ["warn", "08:13 recovery.preview blocked=true"],
    ],
    patch: [
      ["dim", "No patch available while task is failed before implementation."],
    ],
  },
  {
    id: "issue-145",
    title: "Issue #145",
    subtitle: "resume merge-ready batches",
    status: "done",
    branch: "archloop/issue-145",
    sandbox: "podman · archloop:local",
    flow: "with-review",
    terminal: [
      ["dim", "$ npm run typecheck"],
      ["ok", "✓ typecheck completed in 2.6s"],
      ["ok", "✓ merge completed"],
      ["ok", "✓ task closed locally"],
    ],
    events: [
      ["ok", "Yesterday batch.resumed id=b-2026-06-22-03"],
      ["ok", "Yesterday merge.completed sha=8f2a91c"],
    ],
    patch: [["ok", "Merged branch archloop/issue-145 into main."]],
  },
];

const tabLabels = {
  terminal: "Verification stream",
  events: "Hub event log",
  patch: "Patch summary",
};

let selectedRun = runs[0];
let selectedTab = "terminal";

const appShell = document.querySelector(".app-shell");
const runList = document.querySelector("#runList");
const terminalOutput = document.querySelector("#terminalOutput");
const terminalSubtitle = document.querySelector("#terminalSubtitle");
const metaTask = document.querySelector("#metaTask");
const metaStatus = document.querySelector("#metaStatus");
const metaBranch = document.querySelector("#metaBranch");
const metaSandbox = document.querySelector("#metaSandbox");
const metaFlow = document.querySelector("#metaFlow");
const composer = document.querySelector("#composer");
const composerText = document.querySelector("#composerText");
const messageList = document.querySelector("#messageList");
const densityToggle = document.querySelector("#densityToggle");
const approveMerge = document.querySelector("#approveMerge");
const recoverTask = document.querySelector("#recoverTask");
const runButton = document.querySelector("#runButton");

function renderRuns() {
  runList.innerHTML = runs
    .map(
      (run) => `
        <button class="run-card ${run.id === selectedRun.id ? "is-selected" : ""}" type="button" data-run-id="${run.id}">
          <strong>${run.title} · ${run.subtitle}</strong>
          <small>${run.branch}</small>
          <span class="run-card-footer">
            <span class="pill ${statusClass(run.status)}">${run.status}</span>
            <small>${run.flow}</small>
          </span>
        </button>
      `,
    )
    .join("");
}

function renderInspector() {
  metaTask.textContent = selectedRun.title;
  metaStatus.textContent = selectedRun.status;
  metaStatus.className = `status-token ${statusClass(selectedRun.status)}`;
  metaBranch.textContent = selectedRun.branch;
  metaSandbox.textContent = selectedRun.sandbox;
  metaFlow.textContent = selectedRun.flow;
}

function renderTerminal() {
  const lines = selectedRun[selectedTab] ?? selectedRun.terminal;
  terminalSubtitle.textContent = tabLabels[selectedTab];
  terminalOutput.innerHTML = lines
    .map(([tone, text]) => `<span class="${tone}">${escapeHtml(text)}</span>`)
    .join("\n");
}

function statusClass(status) {
  if (status === "failed") return "warning";
  if (status === "done" || status === "waiting_for_merge") return "success";
  return "neutral";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function appendMessage(author, body, avatar = "U") {
  const time = new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());

  const wrapper = document.createElement("div");
  wrapper.className = "message message-user";
  wrapper.innerHTML = `
    <div class="avatar">${avatar}</div>
    <div class="message-body">
      <div class="message-meta">
        <strong>${author}</strong>
        <span>${time}</span>
      </div>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
  messageList.append(wrapper);
  messageList.scrollTop = messageList.scrollHeight;
}

function selectRun(runId) {
  selectedRun = runs.find((run) => run.id === runId) ?? runs[0];
  renderRuns();
  renderInspector();
  renderTerminal();
}

document.addEventListener("click", (event) => {
  const runButtonEl = event.target.closest("[data-run-id]");
  if (runButtonEl) {
    selectRun(runButtonEl.dataset.runId);
  }

  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    selectedTab = tabButton.dataset.tab;
    document
      .querySelectorAll("[data-tab]")
      .forEach((button) =>
        button.classList.toggle("is-selected", button === tabButton),
      );
    renderTerminal();
  }

  const checklistButton = event.target.closest(".checklist button");
  if (checklistButton) {
    const item = checklistButton.closest("li");
    item.classList.toggle("is-done");
    item.classList.remove("is-active");
  }
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = composerText.value.trim();
  if (!value) return;
  appendMessage("Operator", value);
  composerText.value = "";
});

densityToggle.addEventListener("click", () => {
  const compact = appShell.dataset.density !== "compact";
  appShell.dataset.density = compact ? "compact" : "comfortable";
  densityToggle.textContent = compact ? "Comfortable" : "Compact";
});

approveMerge.addEventListener("click", () => {
  selectedRun.status = "merging";
  appendMessage("Operator", "Approve merge for the selected Hub run.", "U");
  selectedRun.events = [
    ...selectedRun.events,
    ["ok", "operator.approved action=merge branch=archloop/issue-148"],
  ];
  selectedTab = "events";
  document
    .querySelectorAll("[data-tab]")
    .forEach((button) =>
      button.classList.toggle("is-selected", button.dataset.tab === "events"),
    );
  renderRuns();
  renderInspector();
  renderTerminal();
});

recoverTask.addEventListener("click", () => {
  appendMessage(
    "Operator",
    "Recover task and preview local Beads state repair.",
    "U",
  );
  selectedRun.events = [
    ...selectedRun.events,
    ["warn", "recovery.requested mode=preview mutation=false"],
  ];
  selectedTab = "events";
  document
    .querySelectorAll("[data-tab]")
    .forEach((button) =>
      button.classList.toggle("is-selected", button.dataset.tab === "events"),
    );
  renderTerminal();
});

runButton.addEventListener("click", () => {
  appendMessage("Operator", "Run with current command bar settings.", "U");
});

renderRuns();
renderInspector();
renderTerminal();
