export type SliceType = "AFK" | "HITL";

export type PrdHubStatus = "inbox" | "ready_for_agent" | "ready_for_human";

export const mapSliceTypeToReadyHubStatus = (
  sliceType: SliceType,
): "ready_for_agent" | "ready_for_human" =>
  sliceType === "AFK" ? "ready_for_agent" : "ready_for_human";
