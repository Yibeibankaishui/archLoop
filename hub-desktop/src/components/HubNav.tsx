import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  hubDesktopNavLabel,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";

export interface HubNavProps {
  readonly sections: readonly HubDesktopNavSection[];
  readonly activeSection: HubDesktopNavSection;
  readonly projectStatus?: HubProjectStatus;
  readonly onNavigate: (section: HubDesktopNavSection) => void;
}

const navShortLabel = (section: HubDesktopNavSection): string => {
  switch (section) {
    case "overview":
      return "OV";
    case "task-board":
      return "TB";
    case "run-workbench":
      return "RW";
    case "proposal-session":
      return "PS";
  }
};

const navIcon = (section: HubDesktopNavSection) => {
  switch (section) {
    case "overview":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="4" y="4" width="5" height="5" rx="1" />
          <rect x="11" y="4" width="5" height="5" rx="1" />
          <rect x="4" y="11" width="5" height="5" rx="1" />
          <rect x="11" y="11" width="5" height="5" rx="1" />
        </svg>
      );
    case "task-board":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3" y="4" width="4" height="12" rx="1" />
          <rect x="8" y="4" width="4" height="12" rx="1" />
          <rect x="13" y="4" width="4" height="12" rx="1" />
        </svg>
      );
    case "run-workbench":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 5h12M4 10h8M4 15h10" />
          <path d="M13 9l3 1-3 1z" />
        </svg>
      );
    case "proposal-session":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 3h7l3 3v11H5z" />
          <path d="M12 3v3h3" />
          <path d="M7 9h6M7 12h6" />
        </svg>
      );
  }
};

export const HubNav = ({
  sections,
  activeSection,
  projectStatus,
  onNavigate,
}: HubNavProps) => (
  <nav className="hub-rail" aria-label="Hub navigation">
    <div className="hub-rail-brand" aria-hidden="true">
      aL
    </div>
    <div className="hub-rail-stack" aria-label="Hub sections">
      {sections.map((section) => {
        const active = section === activeSection;
        return (
          <button
            key={section}
            type="button"
            className={`hub-rail-button hub-focus-ring ${active ? "is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            title={hubDesktopNavLabel(section)}
            onClick={() => onNavigate(section)}
          >
            <span className="hub-rail-button-icon" aria-hidden="true">
              {navIcon(section)}
            </span>
            <span className="hub-sr-only">
              {hubDesktopNavLabel(section)} {navShortLabel(section)}
            </span>
          </button>
        );
      })}
    </div>
    <div className="hub-rail-footer" aria-label="Hub project summary">
      <div className="hub-rail-summary">
        <span className="hub-rail-summary-label">Ready</span>
        <strong>{projectStatus?.taskCounts.ready ?? 0}</strong>
        <span className="hub-rail-summary-divider">/</span>
        <span>{projectStatus?.taskCounts.total ?? 0}</span>
      </div>
      <div className="hub-rail-avatar" aria-hidden="true">
        aL
      </div>
    </div>
  </nav>
);
