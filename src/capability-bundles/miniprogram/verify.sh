#!/usr/bin/env bash
set -euo pipefail

# Mini Program verification wrapper (capability pack).
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

log_has_jsonl_events() {
  [[ -f "$LOG_FILE" ]] && grep -q '"type"' "$LOG_FILE" 2>/dev/null
}

emit_project_wx_check_jsonl() {
  local event_type="$1"
  local exit_code="$2"
  local output="${3-}"
  local message="npm run wx:check completed"
  if [[ "$event_type" == "project_wx_check_summary" ]]; then
    message="npm run wx:check completed (log preserved)"
  fi

  WX_CHECK_EVENT_TYPE="$event_type" \
    WX_CHECK_EXIT_CODE="$exit_code" \
    WX_CHECK_MESSAGE="$message" \
    WX_CHECK_OUTPUT="$output" \
    node -e "
    const exitCode = Number(process.env.WX_CHECK_EXIT_CODE);
    const event = {
      type: process.env.WX_CHECK_EVENT_TYPE,
      severity: exitCode === 0 ? 'info' : 'error',
      message: process.env.WX_CHECK_MESSAGE,
      exit_code: exitCode,
    };
    const output = process.env.WX_CHECK_OUTPUT;
    if (output) event.output = output;
    console.log(JSON.stringify(event));
  "
}

write_project_wx_check_event() {
  emit_project_wx_check_jsonl "project_wx_check" "$1" "$2" >"$LOG_FILE"
}

append_project_wx_check_summary() {
  append_jsonl "$(emit_project_wx_check_jsonl "project_wx_check_summary" "$1")"
}

run_native_fallback() {
  node .archloop/wx-check-native.mjs
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

  if log_has_jsonl_events; then
    append_project_wx_check_summary "$exit_code"
  else
    write_project_wx_check_event "$exit_code" "$output"
  fi
  exit "$exit_code"
fi

run_native_fallback
