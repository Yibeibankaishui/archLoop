/**
 * Suite-level sentinel for the real Hub project registry.
 *
 * Workers isolate XDG_* in `testSetup.ts`. This process still sees the host
 * environment, so it can snapshot `~/.local/share/archloop/hub` before tests
 * and fail the suite if anything mutated it.
 */
import {
  assertHubRegistryUnchanged,
  snapshotRealHubRegistry,
} from "./hubRegistrySentinel.js";

export default async function setup() {
  const snapshot = snapshotRealHubRegistry();
  return async () => {
    assertHubRegistryUnchanged(snapshot);
  };
}
