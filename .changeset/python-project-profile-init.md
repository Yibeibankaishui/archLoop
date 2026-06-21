---
"@yibeibankaishui/archloop": patch
---

Add the Python Project profile to `archloop init`. Scripted and interactive init accept `--project-profile python`, scaffold a setup-only `.archloop/bootstrap.sh` for uv, pip/venv, and Poetry guidance, and add Python, pip, venv, and uv to generated Dockerfile and Containerfile output without installing Poetry by default.
