#!/usr/bin/env bash
set -euo pipefail

MAX_ITERATIONS="${MAX_ITERATIONS:-10}"
MAX_PARALLEL="${MAX_PARALLEL:-4}"
BASE_BRANCH="$(git branch --show-current)"
REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/.sandcastle/logs/local-$(date +%Y%m%d-%H%M%S)"
WORKTREE_ROOT="$REPO_ROOT/.sandcastle/local-worktrees"

mkdir -p "$LOG_DIR"
mkdir -p "$WORKTREE_ROOT"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd codex
require_cmd cursor-agent
require_cmd gh
require_cmd git
require_cmd jq
require_cmd npm

replace_all() {
  local input="$1"
  local needle="$2"
  local replacement="$3"
  printf '%s' "${input//$needle/$replacement}"
}

render_prompt() {
  local template="$1"
  local prompt_cwd="$2"
  local issue_number="${3:-}"
  local issue_title="${4:-}"
  local branch="${5:-}"
  local branches="${6:-}"
  local issues="${7:-}"
  local content

  content="$(<"$template")"
  content="$(replace_all "$content" "{{ISSUE_NUMBER}}" "$issue_number")"
  content="$(replace_all "$content" "{{TASK_ID}}" "$issue_number")"
  content="$(replace_all "$content" "{{ISSUE_TITLE}}" "$issue_title")"
  content="$(replace_all "$content" "{{BRANCH}}" "$branch")"
  content="$(replace_all "$content" "{{BRANCHES}}" "$branches")"
  content="$(replace_all "$content" "{{ISSUES}}" "$issues")"
  content="$(replace_all "$content" "{{SOURCE_BRANCH}}" "$branch")"
  content="$(replace_all "$content" "{{TARGET_BRANCH}}" "$BASE_BRANCH")"

  while [[ "$content" =~ !\`([^\`]*)\` ]]; do
    local block="${BASH_REMATCH[0]}"
    local command="${BASH_REMATCH[1]}"
    local output
    output="$(cd "$prompt_cwd" && eval "$command")"
    content="${content/"$block"/$output}"
  done

  printf '%s' "$content"
}

run_codex() {
  local name="$1"
  local model="$2"
  local effort="$3"
  local prompt="$4"
  local log_file="$5"
  local cwd="$6"

  (
    cd "$cwd"
    printf '%s\n' "$prompt" |
      codex exec \
        --json \
        --dangerously-bypass-approvals-and-sandbox \
        -m "$model" \
        -c "model_reasoning_effort=\"$effort\""
  ) | tee "$log_file"
}

run_cursor() {
  local name="$1"
  local model="$2"
  local prompt="$3"
  local log_file="$4"
  local cwd="$5"

  (
    cd "$cwd"
    printf '%s\n' "$prompt" |
      cursor-agent \
        --print \
        --output-format stream-json \
        --stream-partial-output \
        --trust \
        --model "$model" \
        "$(cat)"
  ) | tee "$log_file"
}

agent_text_from_log() {
  local log_file="$1"

  jq -r '
    if .type == "item.completed" and .item.type == "agent_message" then
      .item.text
    elif .type == "result" and (.result | type == "string") then
      .result
    elif .type == "assistant" and (.message.content | type == "array") then
      [.message.content[]? | select(.text? != null) | .text] | join("")
    else
      empty
    end
  ' "$log_file"
}

branch_has_new_commit() {
  local branch="$1"
  git -C "$REPO_ROOT" rev-list --count "$BASE_BRANCH..$branch" |
    awk '{ exit ($1 > 0 ? 0 : 1) }'
}

prepare_worktree() {
  local issue_number="$1"
  local branch="$2"
  local worktree="$WORKTREE_ROOT/issue-$issue_number"

  if [[ -d "$worktree/.git" || -f "$worktree/.git" ]]; then
    printf '%s' "$worktree"
    return
  fi

  if [[ -e "$worktree" ]]; then
    echo "Worktree path exists but is not a git worktree: $worktree" >&2
    exit 1
  fi

  if git -C "$REPO_ROOT" rev-parse --verify "$branch" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" worktree add "$worktree" "$branch" >/dev/null
  else
    git -C "$REPO_ROOT" worktree add -b "$branch" "$worktree" "$BASE_BRANCH" >/dev/null
  fi

  printf '%s' "$worktree"
}

work_issue() {
  local issue_number="$1"
  local issue_title="$2"
  local branch="$3"
  local issue_dir="$LOG_DIR/issue-$issue_number"
  local worktree
  mkdir -p "$issue_dir"

  echo "  -> #$issue_number $issue_title ($branch)"

  worktree="$(prepare_worktree "$issue_number" "$branch")"

  npm --prefix "$worktree" install
  npm --prefix "$worktree" run build

  local implement_prompt
  implement_prompt="$(
    render_prompt "$REPO_ROOT/.sandcastle/implement-prompt.md" \
      "$worktree" \
      "$issue_number" \
      "$issue_title" \
      "$branch"
  )"
  run_cursor "Implementer #$issue_number" "auto" "$implement_prompt" "$issue_dir/implementer.jsonl" "$worktree"

  if branch_has_new_commit "$branch"; then
    local review_prompt
    review_prompt="$(
      render_prompt "$REPO_ROOT/.sandcastle/review-prompt.md" \
        "$worktree" \
        "$issue_number" \
        "$issue_title" \
        "$branch"
    )"
    run_codex "Reviewer #$issue_number" "gpt-5.5" "medium" "$review_prompt" "$issue_dir/reviewer.jsonl" "$worktree"
  else
    echo "  -> #$issue_number produced no commits; skipping reviewer."
  fi
}

for ((iteration = 1; iteration <= MAX_ITERATIONS; iteration++)); do
  echo
  echo "=== Iteration $iteration/$MAX_ITERATIONS ==="
  echo

  plan_prompt="$(render_prompt "$REPO_ROOT/.sandcastle/plan-prompt.md" "$REPO_ROOT")"
  plan_log="$LOG_DIR/planner-$iteration.jsonl"
  run_codex "Planner" "gpt-5.5" "high" "$plan_prompt" "$plan_log" "$REPO_ROOT"

  plan_text="$(agent_text_from_log "$plan_log")"
  plan_json="$(printf '%s\n' "$plan_text" | perl -0ne 'print $1 if m{<plan>\s*(.*?)\s*</plan>}s')"

  if [[ -z "$plan_json" ]]; then
    echo "Planner did not produce a <plan> tag. See $plan_log" >&2
    exit 1
  fi

  issue_count="$(printf '%s\n' "$plan_json" | jq '.issues | length')"
  if [[ "$issue_count" -eq 0 ]]; then
    echo "No issues to work on. Exiting."
    break
  fi

  echo "Planning complete. $issue_count issue(s) to work in parallel:"
  printf '%s\n' "$plan_json" |
    jq -r '.issues[] | "  #\(.number): \(.title) -> \(.branch)"'

  issues_tsv="$LOG_DIR/issues-$iteration.tsv"
  printf '%s\n' "$plan_json" |
    jq -r '.issues[] | [.number, .title, .branch] | @tsv' >"$issues_tsv"

  completed_tsv="$LOG_DIR/completed-$iteration.tsv"
  : >"$completed_tsv"

  while IFS=$'\t' read -r number title branch; do
    (
      if work_issue "$number" "$title" "$branch"; then
        if branch_has_new_commit "$branch"; then
          printf '%s\t%s\t%s\n' "$number" "$title" "$branch" >>"$completed_tsv"
        fi
      else
        echo "  x #$number ($branch) failed" >&2
      fi
    ) &

    while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$MAX_PARALLEL" ]]; do
      sleep 2
    done
  done <"$issues_tsv"

  wait

  completed_count="$(wc -l <"$completed_tsv" | tr -d ' ')"
  echo
  echo "Execution complete. $completed_count branch(es) with commits:"
  cut -f3 "$completed_tsv" | sed 's/^/  /'

  if [[ "$completed_count" -eq 0 ]]; then
    echo "No commits produced. Nothing to merge."
    continue
  fi

  git -C "$REPO_ROOT" switch "$BASE_BRANCH" >/dev/null

  branches_arg="$(cut -f3 "$completed_tsv" | sed 's/^/- /')"
  issues_arg="$(awk -F '\t' '{ print "- #" $1 ": " $2 }' "$completed_tsv")"
  merge_prompt="$(
    render_prompt "$REPO_ROOT/.sandcastle/merge-prompt.md" \
      "$REPO_ROOT" \
      "" \
      "" \
      "" \
      "$branches_arg" \
      "$issues_arg"
  )"
  run_codex "Merger" "gpt-5.4" "medium" "$merge_prompt" "$LOG_DIR/merger-$iteration.jsonl" "$REPO_ROOT"

  echo
  echo "Branches merged."
done

git -C "$REPO_ROOT" switch "$BASE_BRANCH" >/dev/null
echo
echo "All done. Logs: $LOG_DIR"
