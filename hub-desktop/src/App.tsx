import { useEffect, useMemo, useState } from "react";

import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import type { HubTaskBoard, HubTaskProjection } from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  HUB_DESKTOP_NAV_SECTIONS,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";

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

  const selectedTask = useMemo<HubTaskProjection | undefined>(() => {
    if (!taskBoard || !selectedTaskId) {
      return undefined;
    }
    return taskBoard.tasks.find((task) => task.id === selectedTaskId);
  }, [selectedTaskId, taskBoard]);

  const mainView = (() => {
    if (loading) {
      return <div className="hub-panel hub-empty">Loading local Hub data…</div>;
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
    switch (section) {
      case "overview":
        return <OverviewView status={projectStatus} />;
      case "task-board":
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
        return <RunWorkbenchView status={projectStatus} />;
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
