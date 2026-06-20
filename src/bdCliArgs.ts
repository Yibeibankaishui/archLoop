export const normalizeBdLabels = (
  labels: readonly string[] | string,
): string[] => {
  const raw =
    typeof labels === "string"
      ? labels.split(",")
      : labels.flatMap((label) => label.split(","));
  return raw.map((label) => label.trim()).filter(Boolean);
};

export const appendBdAddLabelArgs = (
  args: string[],
  labels: readonly string[] | string,
): void => {
  for (const label of normalizeBdLabels(labels)) {
    args.push("--add-label", label);
  }
};

export const appendBdRemoveLabelArgs = (
  args: string[],
  labels: readonly string[] | string,
): void => {
  for (const label of normalizeBdLabels(labels)) {
    args.push("--remove-label", label);
  }
};

export const appendBdSetLabelsArgs = (
  args: string[],
  labels: readonly string[] | string,
): void => {
  for (const label of normalizeBdLabels(labels)) {
    args.push("--set-labels", label);
  }
};

export const appendBdMetadataArg = (
  args: string[],
  metadata: Record<string, unknown>,
): void => {
  args.push("--metadata", JSON.stringify(metadata));
};
