#!/usr/bin/env bash
set -euo pipefail

# Mini Program verification entrypoint (capability pack scaffold).
# Does not depend on the capability manifest.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="debug"
LOG_FILE="$LOG_DIR/wx-check.log"
mkdir -p "$LOG_DIR"

append_jsonl() {
  local payload="$1"
  printf '%s\n' "$payload" >>"$LOG_FILE"
}

run_native_fallback() {
  node .sandcastle/wx-check-native.mjs
}

has_wx_check_script() {
  [[ -f package.json ]] || return 1
  node -e "
    const pkg = JSON.parse(require('fs').readFileSync('package.json','utf8'));
    process.exit(pkg.scripts && pkg.scripts['wx:check'] ? 0 : 1);
  " 2>/dev/null
}

if has_wx_check_script; then
  set +e
  output="$(npm run wx:check 2>&1)"
  exit_code=$?
  set -e
  printf '%s\n' "$output" | tee -a "$LOG_FILE" >/dev/null
  if ! grep -q '"type"' "$LOG_FILE" 2>/dev/null; then
    escaped="${output//$'\n'/\\n}"
    append_jsonl "$(node -e "
      console.log(JSON.stringify({
        type: 'project_wx_check',
        severity: exit_code === 0 ? 'info' : 'error',
        message: 'npm run wx:check completed',
        exit_code: Number(process.argv[1]),
        output: process.argv[2],
      }));
    " "$exit_code" "$escaped")"
  else
    append_jsonl "$(node -e "
      console.log(JSON.stringify({
        type: 'project_wx_check_summary',
        severity: exit_code === 0 ? 'info' : 'error',
        message: 'npm run wx:check completed (log preserved)',
        exit_code: Number(process.argv[1]),
      }));
    " "$exit_code")"
  fi
  exit "$exit_code"
fi

run_native_fallback
