import { useEffect, useState } from "react";

import {
  buildHubRuntimeExecuteParams,
  type HubProjectRunSummary,
  type HubProjectStatus,
  type HubRunEventsSnapshot,
  type HubRuntimeActionPreview,
  type HubRuntimePreviewAction,
  type HubTaskBoard,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  HUB_DESKTOP_NAV_SECTIONS,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";
import {
  selectDefaultRunFocus,
  resolveRunBatchRunDir,
} from "@yibeibankaishui/archloop/hub-run-workbench";
import {
  selectDefaultProposalRunDir,
  type ProposalSessionArtifactsSnapshot,
} from "@yibeibankaishui/archloop/hub-proposal-workbench";
import type { HubTaskInspectorModel } from "@yibeibankaishui/archloop/hub-task-board-workbench";

import { hubRuntimeClient } from "./bridge";
import { HubShell } from "./components/HubShell";
import { OverviewView } from "./components/views/OverviewView";
import { ProposalSessionView } from "./components/views/ProposalSessionView";
import { RunWorkbenchView } from "./components/views/RunWorkbenchView";
import { TaskBoardView } from "./components/views/TaskBoardView";

export const App = () => {
  const [section, setSection] = useState<HubDesktopNavSection>("overview");
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [taskInspector, setTaskInspector] = useState<
    HubTaskInspectorModel | undefined
  >();
  const [projectStatus, setProjectStatus] = useState<
    HubProjectStatus | undefined
  >();
  const [taskBoard, setTaskBoard] = useState<HubTaskBoard | undefined>();
  const [runSummaries, setRunSummaries] = useState<
    readonly HubProjectRunSummary[] | undefined
  >();
  const [eventsSnapshot, setEventsSnapshot] = useState<
    HubRunEventsSnapshot | undefined
  >();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedBatchId, setSelectedBatchId] = useState<string | undefined>();
  const [runWorkbenchLoading, setRunWorkbenchLoading] = useState(false);
  const [proposalRunSummaries, setProposalRunSummaries] = useState<
    readonly HubProjectRunSummary[] | undefined
  >();
  const [proposalSessionArtifacts, setProposalSessionArtifacts] = useState<
    ProposalSessionArtifactsSnapshot | undefined
  >();
  const [proposalEventsSnapshot, setProposalEventsSnapshot] = useState<
    HubRunEventsSnapshot | undefined
  >();
  const [selectedProposalRunDir, setSelectedProposalRunDir] = useState<
    string | undefined
  >();
  const [proposalSessionLoading, setProposalSessionLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setRuntimeError(undefined);
      try {
        const bridge = hubRuntimeClient();
        const [statusResult, boardResult] = await Promise.all([
          bridge.invoke({ action: "project.getStatus", params: {} }),
          bridge.invoke({ action: "taskBoard.load", params: {} }),
        ]);
        if (cancelled) {
          return;
        }
        if (!statusResult.ok) {
          setRuntimeError(statusResult.error.message);
          return;
        }
        if (!boardResult.ok) {
          setRuntimeError(boardResult.error.message);
          return;
        }
        setProjectStatus(statusResult.data);
        setTaskBoard(boardResult.data);
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(
            error instanceof Error ? error.message : "Hub runtime unavailable",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (section !== "run-workbench") {
      return;
    }

    let cancelled = false;
    const loadRunWorkbench = async () => {
      setRunWorkbenchLoading(true);
      try {
        const bridge = hubRuntimeClient();
        const summariesResult = await bridge.invoke({
          action: "run.listSummaries",
          params: {},
        });
        if (cancelled) {
          return;
        }
        if (!summariesResult.ok) {
          setRuntimeError(summariesResult.error.message);
          setRunSummaries(undefined);
          setEventsSnapshot(undefined);
          return;
        }

        setRunSummaries(summariesResult.data);
        const focus = selectDefaultRunFocus(
          summariesResult.data,
          projectStatus,
        );
        const runId = selectedRunId ?? focus.runId;
        const batchId = selectedBatchId ?? focus.batchId;
        if (!runId || !batchId) {
          setEventsSnapshot(undefined);
          return;
        }

        const runDir = resolveRunBatchRunDir(
          summariesResult.data,
          runId,
          batchId,
        );
        if (!runDir) {
          setEventsSnapshot(undefined);
          return;
        }

        const eventsResult = await bridge.invoke({
          action: "run.readEvents",
          params: { runDir },
        });
        if (cancelled) {
          return;
        }
        if (!eventsResult.ok) {
          setRuntimeError(eventsResult.error.message);
          setEventsSnapshot(undefined);
          return;
        }
        setEventsSnapshot(eventsResult.data);
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(
            error instanceof Error ? error.message : "Hub runtime unavailable",
          );
          setRunSummaries(undefined);
          setEventsSnapshot(undefined);
        }
      } finally {
        if (!cancelled) {
          setRunWorkbenchLoading(false);
        }
      }
    };

    void loadRunWorkbench();
    return () => {
      cancelled = true;
    };
  }, [section, projectStatus, selectedRunId, selectedBatchId]);

  useEffect(() => {
    if (section !== "proposal-session") {
      return;
    }

    let cancelled = false;
    const loadProposalSession = async () => {
      setProposalSessionLoading(true);
      try {
        const bridge = hubRuntimeClient();
        const summariesResult = await bridge.invoke({
          action: "run.listSummaries",
          params: {},
        });
        if (cancelled) {
          return;
        }
        if (!summariesResult.ok) {
          setRuntimeError(summariesResult.error.message);
          setProposalRunSummaries(undefined);
          setProposalSessionArtifacts(undefined);
          setProposalEventsSnapshot(undefined);
          return;
        }

        setProposalRunSummaries(summariesResult.data);
        const runDir =
          selectedProposalRunDir ??
          selectDefaultProposalRunDir(summariesResult.data);
        if (!runDir) {
          setProposalSessionArtifacts(undefined);
          setProposalEventsSnapshot(undefined);
          return;
        }

        const [sessionResult, eventsResult] = await Promise.all([
          bridge.invoke({
            action: "proposal.readSession",
            params: { runDir },
          }),
          bridge.invoke({
            action: "run.readEvents",
            params: { runDir },
          }),
        ]);
        if (cancelled) {
          return;
        }
        if (!sessionResult.ok) {
          setRuntimeError(sessionResult.error.message);
          setProposalSessionArtifacts(undefined);
          setProposalEventsSnapshot(undefined);
          return;
        }
        if (!eventsResult.ok) {
          setRuntimeError(eventsResult.error.message);
          setProposalEventsSnapshot(undefined);
          setProposalSessionArtifacts(sessionResult.data);
          return;
        }

        setProposalSessionArtifacts(sessionResult.data);
        setProposalEventsSnapshot(eventsResult.data);
      } catch (error) {
        if (!cancelled) {
          setRuntimeError(
            error instanceof Error ? error.message : "Hub runtime unavailable",
          );
          setProposalRunSummaries(undefined);
          setProposalSessionArtifacts(undefined);
          setProposalEventsSnapshot(undefined);
        }
      } finally {
        if (!cancelled) {
          setProposalSessionLoading(false);
        }
      }
    };

    void loadProposalSession();
    return () => {
      cancelled = true;
    };
  }, [section, selectedProposalRunDir]);

  const selectedTaskInspector =
    section === "task-board" ? taskInspector : undefined;
  const shellInspectorOpen =
    section === "run-workbench" ? false : inspectorOpen;

  const previewRuntimeAction = async (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ): Promise<HubRuntimeActionPreview | undefined> => {
    const bridge = hubRuntimeClient();
    const result = await bridge.invoke({
      action,
      params: params as never,
    });
    if (!result.ok) {
      setRuntimeError(result.error.message);
      return undefined;
    }
    return result.data;
  };

  const confirmRuntimeAction = async (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ): Promise<string | undefined> => {
    const bridge = hubRuntimeClient();
    const result = await bridge.invoke({
      action: preview.action,
      params: buildHubRuntimeExecuteParams(preview, params) as never,
    });
    if (!result.ok) {
      return result.error.message;
    }
    return "Action queued for CLI execution.";
  };

  const mainView = (() => {
    switch (section) {
      case "overview":
        return (
          <OverviewView
            status={projectStatus}
            loading={loading}
            runtimeError={runtimeError}
            viewportWidth={viewportWidth}
            onPreviewAction={previewRuntimeAction}
            onConfirmAction={confirmRuntimeAction}
          />
        );
      case "task-board":
        return (
          <TaskBoardView
            board={taskBoard}
            projectStatus={projectStatus}
            loading={loading}
            runtimeError={runtimeError}
            viewportWidth={viewportWidth}
            selectedTaskId={selectedTaskId}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setInspectorOpen(true);
            }}
            onInspectorChange={setTaskInspector}
            onPreviewAction={previewRuntimeAction}
            onConfirmAction={confirmRuntimeAction}
          />
        );
      case "run-workbench":
        return (
          <RunWorkbenchView
            status={projectStatus}
            runSummaries={runSummaries}
            eventsSnapshot={eventsSnapshot}
            loading={loading || runWorkbenchLoading}
            runtimeError={runtimeError}
            viewportWidth={viewportWidth}
            selectedRunId={selectedRunId}
            selectedBatchId={selectedBatchId}
            onSelectRun={(runId, batchId) => {
              setSelectedRunId(runId);
              setSelectedBatchId(batchId);
            }}
            onPreviewAction={previewRuntimeAction}
            onConfirmAction={confirmRuntimeAction}
          />
        );
      case "proposal-session":
        return (
          <ProposalSessionView
            status={projectStatus}
            runSummaries={proposalRunSummaries}
            sessionArtifacts={proposalSessionArtifacts}
            eventsSnapshot={proposalEventsSnapshot}
            loading={loading || proposalSessionLoading}
            runtimeError={runtimeError}
            viewportWidth={viewportWidth}
            selectedRunDir={selectedProposalRunDir}
            onSelectRunDir={setSelectedProposalRunDir}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <HubShell
      activeSection={section}
      sections={HUB_DESKTOP_NAV_SECTIONS}
      viewportWidth={viewportWidth}
      inspectorOpen={shellInspectorOpen}
      taskInspector={selectedTaskInspector}
      projectStatus={projectStatus}
      onNavigate={setSection}
      onToggleInspector={() => setInspectorOpen((open) => !open)}
      onPreviewAction={previewRuntimeAction}
      onConfirmAction={confirmRuntimeAction}
    >
      {mainView}
    </HubShell>
  );
};
