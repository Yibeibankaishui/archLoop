import { useState } from "react";

import type {
  HubRuntimeActionPreview,
  HubRuntimePreviewAction,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

export interface HubWorkbenchActionShape {
  readonly label: string;
  readonly description: string;
  readonly kind: "bridge_preview" | "cli_only";
  readonly bridgeAction?: HubRuntimePreviewAction;
  readonly bridgeParams?: Record<string, unknown>;
  readonly cliFallback: string;
  readonly disabledReason?: string;
}

export interface HubWorkbenchActionButtonProps {
  readonly action: HubWorkbenchActionShape;
  readonly variant: "task-board" | "inspector";
  readonly onPreviewAction?: (
    action: HubRuntimePreviewAction,
    params: Record<string, unknown>,
  ) => Promise<HubRuntimeActionPreview | undefined>;
  readonly onConfirmAction?: (
    preview: HubRuntimeActionPreview,
    params: Record<string, unknown>,
  ) => Promise<string | undefined>;
}

const VARIANT_CLASSES = {
  "task-board": {
    root: "hub-task-board-action",
    copy: "hub-task-board-action-copy",
    controls: "hub-task-board-action-controls",
  },
  inspector: {
    root: "hub-inspector-action",
    copy: null,
    controls: "hub-inspector-action-controls",
  },
} as const;

export const HubWorkbenchActionButton = ({
  action,
  variant,
  onPreviewAction,
  onConfirmAction,
}: HubWorkbenchActionButtonProps) => {
  const [preview, setPreview] = useState<HubRuntimeActionPreview | undefined>();
  const [previewParams, setPreviewParams] = useState<
    Record<string, unknown> | undefined
  >();
  const [pending, setPending] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | undefined>();
  const disabled = action.disabledReason !== undefined;
  const classes = VARIANT_CLASSES[variant];

  const handlePreview = async () => {
    if (
      disabled ||
      action.kind !== "bridge_preview" ||
      !action.bridgeAction ||
      !onPreviewAction
    ) {
      return;
    }
    setPending(true);
    setResultMessage(undefined);
    try {
      const nextPreview = await onPreviewAction(
        action.bridgeAction,
        action.bridgeParams ?? {},
      );
      setPreviewParams(action.bridgeParams ?? {});
      setPreview(nextPreview);
    } finally {
      setPending(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || !previewParams || !onConfirmAction || preview.disabledReason) {
      return;
    }
    setPending(true);
    try {
      const message = await onConfirmAction(preview, previewParams);
      setResultMessage(message ?? "Action queued for CLI execution.");
      setPreview(undefined);
      setPreviewParams(undefined);
    } finally {
      setPending(false);
    }
  };

  const body = (
    <>
      <strong>{action.label}</strong>
      <p className="hub-muted">{action.description}</p>
      {action.disabledReason ? (
        <p className="hub-muted">{action.disabledReason}</p>
      ) : null}
      <p className="hub-muted">
        CLI: <code>{action.cliFallback}</code>
      </p>
      {resultMessage ? <p className="hub-muted">{resultMessage}</p> : null}
      {preview ? (
        <div className="hub-panel">
          <p>{preview.summary}</p>
          {preview.disabledReason ? (
            <p className="hub-muted">{preview.disabledReason}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <div className={classes.root}>
      {classes.copy ? <div className={classes.copy}>{body}</div> : body}
      <div className={classes.controls}>
        {action.kind === "bridge_preview" ? (
          <>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={disabled || pending}
              onClick={() => void handlePreview()}
            >
              Preview
            </button>
            <button
              type="button"
              className="hub-button hub-focus-ring"
              disabled={!preview || pending || Boolean(preview.disabledReason)}
              onClick={() => void handleConfirm()}
            >
              Confirm
            </button>
          </>
        ) : (
          <button
            type="button"
            className="hub-button hub-focus-ring"
            disabled={disabled}
            title={action.disabledReason ?? action.cliFallback}
          >
            CLI only
          </button>
        )}
      </div>
    </div>
  );
};
