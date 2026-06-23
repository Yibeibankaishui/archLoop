import type { ReactNode } from "react";

import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import type {
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import type { HubTaskInspectorModel } from "@yibeibankaishui/archloop/hub-task-board-workbench";
import {
  HUB_DESKTOP_LAYOUT,
  hubDesktopNavLabel,
  hubDesktopShellGridStyle,
  shouldCollapseInspector,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";

import { HubHeader } from "./HubHeader";
import { HubNav } from "./HubNav";
import { InspectorPanel } from "./InspectorPanel";

export interface HubShellProps {
  readonly activeSection: HubDesktopNavSection;
  readonly sections: readonly HubDesktopNavSection[];
  readonly viewportWidth: number;
  readonly inspectorOpen: boolean;
  readonly taskInspector?: HubTaskInspectorModel;
  readonly projectStatus?: HubProjectStatus;
  readonly onNavigate: (section: HubDesktopNavSection) => void;
  readonly onToggleInspector: () => void;
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
  readonly children: ReactNode;
}

export const HubShell = ({
  activeSection,
  sections,
  viewportWidth,
  inspectorOpen,
  taskInspector,
  projectStatus,
  onNavigate,
  onToggleInspector,
  onPreviewAction,
  onConfirmAction,
  children,
}: HubShellProps) => {
  const collapseInspector = shouldCollapseInspector(viewportWidth);
  const showInspector = inspectorOpen && !collapseInspector;

  return (
    <div
      className="hub-shell"
      style={hubDesktopShellGridStyle(viewportWidth)}
      data-layout={collapseInspector ? "narrow" : "desktop"}
    >
      <HubNav
        sections={sections}
        activeSection={activeSection}
        onNavigate={onNavigate}
      />
      <HubHeader
        activeSection={activeSection}
        projectStatus={projectStatus}
        onToggleInspector={onToggleInspector}
        inspectorOpen={inspectorOpen}
        collapseInspector={collapseInspector}
      />
      <main className="hub-main" aria-label={hubDesktopNavLabel(activeSection)}>
        {children}
      </main>
      {showInspector ? (
        <InspectorPanel
          taskInspector={taskInspector}
          projectStatus={projectStatus}
          style={{ width: HUB_DESKTOP_LAYOUT.inspectorWidthPx }}
          onPreviewAction={onPreviewAction}
          onConfirmAction={onConfirmAction}
        />
      ) : null}
      {collapseInspector && inspectorOpen ? (
        <div className="hub-drawer-backdrop" onClick={onToggleInspector}>
          <aside
            className="hub-drawer"
            onClick={(event) => event.stopPropagation()}
          >
            <InspectorPanel
              taskInspector={taskInspector}
              projectStatus={projectStatus}
              onPreviewAction={onPreviewAction}
              onConfirmAction={onConfirmAction}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
};
