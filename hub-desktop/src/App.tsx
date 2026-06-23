import { useEffect, useMemo, useState } from "react";

import {
  buildHubRuntimeExecuteParams,
  type HubProjectRunSummary,
  type HubProjectStatus,
  type HubRunEventsSnapshot,
  type HubRuntimeActionPreview,
  type HubRuntimePreviewAction,
  type HubTaskBoard,
  type HubTaskProjection,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  HUB_DESKTOP_NAV_SECTIONS,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";
import { selectDefaultRunFocus } from "@yibeibankaishui/archloop/hub-run-workbench";

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
        const focus = selectDefaultRunFocus(summariesResult.data, projectStatus);
        const runId = selectedRunId ?? focus.runId;
        const batchId = selectedBatchId ?? focus.batchId;
        if (!runId || !batchId) {
          setEventsSnapshot(undefined);
          return;
        }

        const run = summariesResult.data.find((entry) => entry.runId === runId);
        const batch = run?.batches.find((entry) => entry.batchId === batchId);
        if (!batch) {
          setEventsSnapshot(undefined);
          return;
        }

        const eventsResult = await bridge.invoke({
          action: "run.readEvents",
          params: { runDir: batch.runDir },
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

  const selectedTask = useMemo<HubTaskProjection | undefined>(() => {
    if (!taskBoard || !selectedTaskId) {
      return undefined;
    }
    return taskBoard.tasks.find((task) => task.id === selectedTaskId);
  }, [selectedTaskId, taskBoard]);

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
        if (loading) {
          return (
            <div className="hub-panel hub-empty">Loading local Hub data…</div>
          );
        }
        if (runtimeError) {
          return (
            <div className="hub-panel hub-empty hub-error" role="alert">
              <h2>Runtime unavailable</h2>
              <p>{runtimeError}</p>
              <p className="hub-muted">
                CLI fallback: <code>archloop project status</code>
              </p>
            </div>
          );
        }
        return (
          <TaskBoardView
            board={taskBoard}
            selectedTaskId={selectedTaskId}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setInspectorOpen(true);
            }}
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
        return <ProposalSessionView />;
      default:
        return null;
    }
  })();

  return (
    <HubShell
      activeSection={section}
      sections={HUB_DESKTOP_NAV_SECTIONS}
      viewportWidth={viewportWidth}
      inspectorOpen={inspectorOpen}
      selectedTask={selectedTask}
      projectStatus={projectStatus}
      onNavigate={setSection}
      onToggleInspector={() => setInspectorOpen((open) => !open)}
    >
      {mainView}
    </HubShell>
  );
};
