#!/usr/bin/env bash
# needs-rob-gate.sh — decide whether a pull request is under the `needs-rob`
# hold (#891): a change the review ruled human-owned under CLAUDE.md §7, which
# only Rob may release. Every publisher of the `Claude verdict` status runs
# this and turns the verdict red while the hold is present.
#
# usage:  needs-rob-gate.sh <labels.json> <timeline.json>
#         labels.json    GET repos/{repo}/issues/{pr}/labels
#         timeline.json  GET repos/{repo}/issues/{pr}/timeline
#         Either file may hold one page (a flat array) or `--paginate --slurp`
#         output (an array of pages).
# stdout: an explanation, then two machine-readable lines, the LAST being the
#         decision: `reason=<code>` followed by `needs_rob=present|absent`.
# exit:   always 0. The decision is the last line, never the exit status, so a
#         caller cannot mistake a crash for "absent".
#
# Label presence alone is not a safe signal. The review lane is a model session
# that reads attacker-authored PR text and may run `gh pr edit --remove-label`,
# so a steered review could strip the label. The hold is therefore STICKY: the
# label counts as present until a HUMAN removes it. Concretely:
#   - the label is on the PR                                   -> present
#   - the most recent labeled/unlabeled event for `needs-rob`
#     is an `unlabeled` whose actor is a bot (`type: Bot`, a
#     `[bot]` login, or no actor at all)                        -> present
#   - ... whose actor is a human                                -> absent
#   - the label was never applied to the PR                     -> absent
#   - the label is off the PR but the last event is `labeled`   -> present
#     (the labels list and the timeline disagree; this is also what a repo-wide
#     label deletion looks like, which leaves no `unlabeled` event behind)
#   - unreadable input                                          -> present
# Everything uncertain fails CLOSED. A human removal made through Rob's token by
# an authoring session is indistinguishable from Rob here; CLAUDE.md §7 makes
# that void by policy, not by this script.
set -uo pipefail

LABEL="needs-rob"

decide() { # present|absent code explanation
  echo "$3"
  echo "reason=$2"
  echo "needs_rob=$1"
  exit 0
}

if [ "$#" -ne 2 ]; then
  decide present invalid-input "usage: needs-rob-gate.sh <labels.json> <timeline.json>"
fi

# Accept one page or `--paginate --slurp` pages; anything else is unreadable.
flatten='if type == "array" and (.[0] | type) == "array" then flatten(1) else . end
         | if type == "array" then . else error("not an array") end'

labels=$(jq -c "$flatten" "$1" 2>/dev/null) \
  || decide present invalid-input "labels JSON could not be parsed"
timeline=$(jq -c "$flatten" "$2" 2>/dev/null) \
  || decide present invalid-input "timeline JSON could not be parsed"

if jq -e --arg l "$LABEL" 'map(select(type == "object" and .name == $l)) | length > 0' \
    <<<"$labels" >/dev/null; then
  decide present label-present "$LABEL is on the pull request"
fi

# The most recent labeled/unlabeled event for this label, in API order (stable
# sort by created_at guards against page boundaries).
last=$(jq -c --arg l "$LABEL" '
  map(select(type == "object"
             and (.event == "labeled" or .event == "unlabeled")
             and (.label | type) == "object"
             and .label.name == $l))
  | sort_by(.created_at // "")
  | last // empty' <<<"$timeline")

if [ -z "$last" ]; then
  decide absent never-applied "$LABEL is not on the pull request and was never applied"
fi

event=$(jq -r '.event' <<<"$last")
if [ "$event" = "labeled" ]; then
  decide present applied-but-missing \
    "$LABEL is off the pull request but its last timeline event is 'labeled' (labels and timeline disagree, or the label was deleted repo-wide)"
fi

actor_login=$(jq -r '.actor.login // ""' <<<"$last")
actor_type=$(jq -r '.actor.type // ""' <<<"$last")
if [ "$actor_type" = "User" ] && [ -n "$actor_login" ] && [[ "$actor_login" != *"[bot]" ]]; then
  decide absent human-removed "$LABEL was removed by $actor_login (human)"
fi

decide present bot-removed \
  "$LABEL was removed by '${actor_login:-<no actor>}' (${actor_type:-unknown type}); only a human may release the hold"
