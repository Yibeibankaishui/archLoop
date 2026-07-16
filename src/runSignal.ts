export interface RunSignalEventSource {
  readonly on: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  readonly off: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
}

export interface RunCancellationError extends Error {
  readonly code: "ABORT_ERR";
  readonly exitCode: 130 | 143;
  readonly signal: "SIGINT" | "SIGTERM";
}

export const getSignalExitCode = (signal: "SIGINT" | "SIGTERM"): 130 | 143 =>
  signal === "SIGINT" ? 130 : 143;

const createRunCancellationError = (
  signal: "SIGINT" | "SIGTERM",
): RunCancellationError => {
  const error = new Error(`Run cancelled by ${signal}`) as RunCancellationError;
  error.name = "AbortError";
  Object.assign(error, {
    code: "ABORT_ERR" as const,
    exitCode: getSignalExitCode(signal),
    signal,
  });
  return error;
};

export const getRunCancellationExitCode = (error: unknown): 130 | 143 => {
  if (
    error &&
    typeof error === "object" &&
    "exitCode" in error &&
    (error.exitCode === 130 || error.exitCode === 143)
  ) {
    return error.exitCode;
  }
  return 130;
};

export const createRunSignalController = (
  source: RunSignalEventSource = process,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} => {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort(createRunCancellationError("SIGINT"));
  };
  const onSigterm = (): void => {
    controller.abort(createRunCancellationError("SIGTERM"));
  };

  source.on("SIGINT", onSigint);
  source.on("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    dispose: () => {
      source.off("SIGINT", onSigint);
      source.off("SIGTERM", onSigterm);
    },
  };
};
