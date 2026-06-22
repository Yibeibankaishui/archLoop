---
"@yibeibankaishui/archloop": patch
---

When `archloop docker build-image` runs as root (host UID 0), default build-args use AGENT_UID/GID 1000 instead of 0 so the image build no longer fails with `usermod: UID '0' already exists`. CLI prints guidance to pass `containerUid` / `containerGid` at runtime to match the image.
