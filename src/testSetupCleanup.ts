import { rmSync } from "node:fs";

export const removeTestTempDirectories = (paths: readonly string[]): void => {
  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort because the test result must remain primary.
    }
  }
};
