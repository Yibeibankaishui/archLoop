---
"@yibeibankaishui/archloop": patch
---

Apply `:z` SELinux label by default on Docker bind mounts, matching the existing Podman behavior. Adds `selinuxLabel` option to `DockerOptions` (`"z"` | `"Z"` | `false`, default `"z"`). Extracts shared `formatVolumeMount` from Podman provider into `src/mountUtils.ts` so both providers use the same volume-mount formatter.
