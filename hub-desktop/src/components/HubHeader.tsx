import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { HubProjectStatus } from "@yibeibankaishui/archloop/hub-runtime-contract";
import {
  HUB_DESKTOP_SHELL_TABS,
  hubDesktopNavLabel,
  type HubDesktopNavSection,
} from "@yibeibankaishui/archloop/hub-desktop-shell";
import type {
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

type HeaderIconKind = "notifications" | "help" | "avatar";

const HEADER_ICON_BUTTONS = [
  { label: "Notifications", kind: "notifications" },
  { label: "Help", kind: "help" },
  { label: "Account", kind: "avatar" },
] as const;

const inspectorToggleLabel = (
  collapseInspector: boolean,
  inspectorOpen: boolean,
): string => {
  if (collapseInspector) {
    return inspectorOpen ? "Close inspector" : "Open inspector";
  }
  return inspectorOpen ? "Hide inspector" : "Show inspector";
};

const headerIcon = (kind: HeaderIconKind): ReactNode => {
  switch (kind) {
    case "notifications":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 4a4 4 0 0 0-4 4v2.2c0 .8-.2 1.6-.6 2.3L4 14h12l-1.4-1.5c-.4-.7-.6-1.5-.6-2.3V8a4 4 0 0 0-4-4Z" />
          <path d="M8 14a2 2 0 0 0 4 0" />
        </svg>
      );
    case "help":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7.5 7.5a2.5 2.5 0 1 1 4 2c-.8.7-1.5 1.1-1.5 2" />
          <circle cx="10" cy="14.5" r=".75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "avatar":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="7" r="3" />
          <path d="M4.5 16a5.5 5.5 0 0 1 11 0" />
        </svg>
      );
  }
};

const syncPreviewActionForStatus = (
  projectStatus?: HubProjectStatus,
):
  | {
      readonly bridgeAction: HubRuntimePreviewAction;
      readonly disabledReason?: string;
    }
  | undefined => {
  if (!projectStatus) {
    return undefined;
  }

  const { pushPending, conflict, localOnly } = projectStatus.syncCounts;
  const pendingTotal = pushPending + conflict + localOnly;

  if (conflict > 0) {
    return {
      bridgeAction: "sync.pullPreview",
      disabledReason: "Resolve sync conflicts from the CLI before previewing.",
    };
  }

  if (pendingTotal === 0) {
    return {
      bridgeAction: "sync.pushPreview",
      disabledReason: "No sync changes to preview.",
    };
  }

  return { bridgeAction: "sync.pushPreview" };
};

const isHeaderTabActive = (
  tabSection: HubDesktopNavSection,
  tabKey: (typeof HUB_DESKTOP_SHELL_TABS)[number]["key"],
  activeSection: HubDesktopNavSection,
): boolean =>
  tabSection === activeSection ||
  (activeSection === "proposal-session" && tabKey === "batch");

const HeaderIconButton = ({
  label,
  kind,
  disabled,
}: {
  readonly label: string;
  readonly kind: HeaderIconKind;
  readonly disabled?: boolean;
}) => (
  <button
    type="button"
    className="hub-header-icon-button hub-focus-ring"
    aria-label={label}
    disabled={disabled}
    title={label}
  >
    {headerIcon(kind)}
  </button>
);

const HeaderPreviewAction = ({
  label,
  bridgeAction,
  cliFallback,
  disabledReason,
  onPreviewAction,
  onConfirmAction,
}: {
  readonly label: string;
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly cliFallback: string;
  readonly disabledReason?: string;
  readonly onPreviewAction?: HubHeaderProps["onPreviewAction"];
  readonly onConfirmAction?: HubHeaderProps["onConfirmAction"];
}) => {
  const [preview, setPreview] = useState<HubRuntimeActionPreview | undefined>();
  const previewParamsRef = useRef<Record<string, unknown> | undefined>(
    undefined,
  );
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const disabled = disabledReason !== undefined;

  const handlePreview = async () => {
    if (!bridgeAction || disabled || !onPreviewAction) {
      return;
    }

    setPending(true);
    setResultMessage(undefined);
    try {
      const nextPreviewParams = {};
      const nextPreview = await onPreviewAction(
        bridgeAction,
        nextPreviewParams,
      );
      previewParamsRef.current = nextPreviewParams;
      setPreview(nextPreview);
    } finally {
      setPending(false);
    }
  };

  const handleConfirm = async () => {
    const previewParams = previewParamsRef.current;
    if (
      !preview ||
      !previewParams ||
      !onConfirmAction ||
      preview.disabledReason
    ) {
      return;
    }

    setPending(true);
    try {
      const message = await onConfirmAction(preview, previewParams);
      setResultMessage(message ?? "Action queued for CLI execution.");
      setPreview(undefined);
      previewParamsRef.current = undefined;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="hub-header-action">
      <button
        type="button"
        className="hub-button hub-focus-ring"
        disabled={disabled || pending || !onPreviewAction || !bridgeAction}
        onClick={() => void handlePreview()}
      >
        {pending ? `${label}…` : label}
      </button>
      <p className="hub-muted hub-header-action-note">
        {disabledReason ?? (
          <>
            CLI fallback: <code>{cliFallback}</code>
          </>
        )}
      </p>
      {preview ? (
        <div
          className="hub-header-preview"
          role="region"
          aria-label={`${label} preview`}
        >
          <p>{preview.summary}</p>
          {preview.disabledReason ? (
            <p className="hub-muted" role="status">
              {preview.disabledReason}
            </p>
          ) : (
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={pending || !onConfirmAction}
              onClick={() => void handleConfirm()}
            >
              Confirm
            </button>
          )}
        </div>
      ) : null}
      {resultMessage ? (
        <p className="hub-muted" role="status">
          {resultMessage}
        </p>
      ) : null}
    </div>
  );
};

export interface HubHeaderProps {
  readonly activeSection: HubDesktopNavSection;
  readonly projectStatus?: HubProjectStatus;
  readonly inspectorOpen: boolean;
  readonly collapseInspector: boolean;
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
}

export const HubHeader = ({
  activeSection,
  projectStatus,
  inspectorOpen,
  collapseInspector,
  onNavigate,
  onToggleInspector,
  onPreviewAction,
  onConfirmAction,
}: HubHeaderProps) => {
  const syncPreview = syncPreviewActionForStatus(projectStatus);
  const readyCount = projectStatus?.taskCounts.ready ?? 0;
  const totalCount = projectStatus?.taskCounts.total ?? 0;

  return (
    <header className="hub-header">
      <div className="hub-header-copy">
        <p className="hub-eyebrow">archLoop Hub</p>
        <h1>{hubDesktopNavLabel(activeSection)}</h1>
        <div className="hub-header-chips" aria-label="Project summary">
          <span className="hub-chip">
            {readyCount} ready / {totalCount} total
          </span>
          <span
            className={`hub-chip ${projectStatus?.beadsAvailable ? "is-ready" : "is-warning"}`}
          >
            {projectStatus?.beadsAvailable
              ? "Beads ready"
              : "Beads unavailable"}
          </span>
        </div>
      </div>

      <nav className="hub-header-tabs" aria-label="Hub sections">
        {HUB_DESKTOP_SHELL_TABS.map((tab) => {
          const active = isHeaderTabActive(tab.section, tab.key, activeSection);
          return (
            <button
              key={tab.key}
              type="button"
              className={`hub-header-tab hub-focus-ring ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(tab.section)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="hub-header-actions">
        <HeaderPreviewAction
          label="Sync"
          bridgeAction={syncPreview?.bridgeAction}
          cliFallback="archloop tasks sync"
          disabledReason={syncPreview?.disabledReason}
          onPreviewAction={onPreviewAction}
          onConfirmAction={onConfirmAction}
        />
        <div className="hub-header-action">
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled
            aria-label="Run Flow unavailable in desktop v0"
            title="Use archloop run . --flow <id>"
          >
            Run Flow
          </button>
          <p className="hub-muted hub-header-action-note">
            CLI fallback: <code>archloop run . --flow &lt;id&gt;</code>
          </p>
        </div>
        <button
          type="button"
          className="hub-button hub-focus-ring"
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
        >
          {inspectorToggleLabel(collapseInspector, inspectorOpen)}
        </button>
        {HEADER_ICON_BUTTONS.map((button) => (
          <HeaderIconButton
            key={button.kind}
            label={button.label}
            kind={button.kind}
            disabled
          />
        ))}
      </div>
    </header>
  );
};
