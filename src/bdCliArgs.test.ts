import { describe, expect, it } from "vitest";
import {
  appendBdAddLabelArgs,
  appendBdRemoveLabelArgs,
  normalizeBdLabels,
} from "./bdCliArgs.js";

describe("bdCliArgs", () => {
  it("normalizes comma-separated and array label input", () => {
    expect(normalizeBdLabels(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeBdLabels("a,b")).toEqual(["a", "b"]);
    expect(normalizeBdLabels(["a,b", " c "])).toEqual(["a", "b", "c"]);
    expect(normalizeBdLabels("")).toEqual([]);
  });

  it("appends repeatable bd label flags", () => {
    const args: string[] = ["update", "task-1"];
    appendBdAddLabelArgs(args, ["ready-for-agent", "inbox"]);
    appendBdRemoveLabelArgs(args, "needs-info,blocked");

    expect(args).toEqual([
      "update",
      "task-1",
      "--add-label",
      "ready-for-agent",
      "--add-label",
      "inbox",
      "--remove-label",
      "needs-info",
      "--remove-label",
      "blocked",
    ]);
  });
});
