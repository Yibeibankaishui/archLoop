import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import { hubDesktopNavLabel, type HubDesktopNavSection } from "@yibeibankaishui/archloop/hub-desktop-shell";

const inspectorToggleLabel = (
  collapseInspector: boolean,
  inspectorOpen: boolean,
): string => {
  if (collapseInspector) {
    return inspectorOpen ? "Close inspector" : "Open inspector";
  }
  return inspectorOpen ? "Hide inspector" : "Show inspector";
};

export interface HubHeaderProps {
  readonly activeSection: HubDesktopNavSection;
  readonly projectStatus?: HubProjectStatus;
  readonly inspectorOpen: boolean;
  readonly collapseInspector: boolean;
  readonly onToggleInspector: () => void;
}

export const HubHeader = ({
  activeSection,
  projectStatus,
  inspectorOpen,
  collapseInspector,
  onToggleInspector,
}: HubHeaderProps) => (
  <header className="hub-header">
    <div className="hub-header-copy">
      <p className="hub-eyebrow">archLoop Hub</p>
      <h1>{hubDesktopNavLabel(activeSection)}</h1>
    </div>
    <div className="hub-header-meta">
      <span className="hub-chip">
        {projectStatus?.taskCounts.ready ?? 0} ready /{" "}
        {projectStatus?.taskCounts.total ?? 0} total
      </span>
      <span
        className={`hub-chip ${projectStatus?.beadsAvailable ? "is-ready" : "is-warning"}`}
      >
        {projectStatus?.beadsAvailable ? "Beads ready" : "Beads unavailable"}
      </span>
      <button
        type="button"
        className="hub-button hub-focus-ring"
        onClick={onToggleInspector}
        aria-pressed={inspectorOpen}
      >
        {inspectorToggleLabel(collapseInspector, inspectorOpen)}
      </button>
    </div>
  </header>
);
