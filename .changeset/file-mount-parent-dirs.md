---
"@yibeibankaishui/archloop": patch
---

Auto-create parent directories for file-target bind mounts under `/home/agent`. When a user mount targets a single file whose sandbox-side parent directory may not exist in the image (e.g. `/home/agent/.codex/auth.json`), both Docker and Podman providers now run `mkdir -p` + `chown` on the parent at container start. File mounts whose parent is outside `/home/agent` fail at config time with a clear error and remediation guidance.
