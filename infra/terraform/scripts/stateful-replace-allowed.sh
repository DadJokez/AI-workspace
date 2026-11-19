#!/usr/bin/env bash
# stateful-replace-allowed.sh — may this pull request's plan destroy or replace
# a resource that holds data? Only when it carries the label
# `allow-stateful-replace`, and only Rob applies that label.
#
# usage:  stateful-replace-allowed.sh <labels.json> <timeline.json>
#         labels.json    GET repos/{repo}/issues/{pr}/labels
#         timeline.json  GET repos/{repo}/issues/{pr}/timeline
#         Either file may hold one page or `--paginate --slurp` pages.
# stdout: an explanation, then the decision as the LAST line:
#         `allowed=true` or `allowed=false`.
# exit:   always 0; the decision is the last line, never the exit status.
#
# Label presence alone is not enough, for the reason
# .github/scripts/needs-rob-gate.sh gives: the review lane is a model session
# that reads author-written text and can run `gh pr edit --add-label`. The
# label therefore counts only when it is on the pull request AND the most
# recent `labeled` event for it was made by a human (a `User` actor whose
# login is not a `[bot]`). Everything uncertain is `allowed=false`. That a
# human label means Rob is the same policy as CLAUDE.md §7: a label added
# through Rob's token by an authoring session is void.
set -uo pipefail

LABEL="allow-stateful-replace"

decide() { # true|false explanation
  echo "$2"
  echo "allowed=$1"
  exit 0
}

[ "$#" -eq 2 ] || decide false "usage: stateful-replace-allowed.sh <labels.json> <timeline.json>"

flatten='if type == "array" and (.[0] | type) == "array" then flatten(1) else . end
         | if type == "array" then . else error("not an array") end'
labels=$(jq -c "$flatten" "$1" 2>/dev/null) || decide false "labels JSON could not be parsed"
timeline=$(jq -c "$flatten" "$2" 2>/dev/null) || decide false "timeline JSON could not be parsed"

jq -e --arg l "$LABEL" 'any(.[]; type == "object" and .name == $l)' <<<"$labels" >/dev/null ||
  decide false "$LABEL is not on the pull request"

last=$(jq -c --arg l "$LABEL" '
  map(select(type == "object" and .event == "labeled"
             and (.label | type) == "object" and .label.name == $l))
  | sort_by(.created_at // "")
  | last // empty' <<<"$timeline")
[ -n "$last" ] || decide false "$LABEL is on the pull request but the timeline has no event that applied it"

actor_login=$(jq -r '.actor.login // ""' <<<"$last")
actor_type=$(jq -r '.actor.type // ""' <<<"$last")
if [ "$actor_type" = "User" ] && [ -n "$actor_login" ] && [[ "$actor_login" != *"[bot]" ]]; then
  decide true "$LABEL was applied by $actor_login (human)"
fi
decide false "$LABEL was applied by '${actor_login:-<no actor>}' (${actor_type:-unknown type}); only a human may apply it"
