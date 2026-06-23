import {
  hubDesktopNavLabel,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";

export interface HubNavProps {
  readonly sections: readonly HubDesktopNavSection[];
  readonly activeSection: HubDesktopNavSection;
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

export const HubNav = ({
  sections,
  activeSection,
  onNavigate,
}: HubNavProps) => (
  <nav className="hub-rail" aria-label="Hub navigation">
    <div className="hub-rail-brand" aria-hidden="true">
      aL
    </div>
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
          <span aria-hidden="true">{navShortLabel(section)}</span>
          <span className="hub-sr-only">{hubDesktopNavLabel(section)}</span>
        </button>
      );
    })}
  </nav>
);
