#!/usr/bin/env bash
# classify-release-build.sh — decide whether a push to the default branch needs
# a new image set (.github/workflows/build-release.yml).
#
# stdin:  NUL-delimited changed paths, as printed by
#         `git diff --name-only --no-renames -z <before> <after>`.
# stdout: an explanation, then the decision as the LAST line: `build=true` or
#         `build=false`.
# exit:   always 0. The decision is the last line, never the exit status, so a
#         caller cannot mistake a crash for "nothing to build".
#
# Two kinds of push build nothing:
#   - a release bump: only envs/<env>/release.auto.tfvars files changed. That
#     is the merge of the pull request a build opened; building it again would
#     open the next one, without end.
#   - inert documentation, by the rules of classify-docs-only.sh.
# Everything else builds, and so does an empty path list: with nothing to
# judge, an unneeded build is the cheaper mistake.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
release_file='^infra/terraform/envs/[a-z0-9-]+/release\.auto\.tfvars$'

paths=()
while IFS= read -r -d '' path; do
  [ -n "$path" ] && paths+=("$path")
done

if ((${#paths[@]} == 0)); then
  echo "no changed paths to judge"
  echo "build=true"
  exit 0
fi

rest=()
for path in "${paths[@]}"; do
  if [[ "$path" =~ $release_file ]]; then
    echo "skip   $path  (release file)"
  else
    rest+=("$path")
  fi
done

if ((${#rest[@]} == 0)); then
  echo "only release files changed: this push deploys images, it does not make them"
  echo "build=false"
  exit 0
fi

report=$(printf '%s\0' "${rest[@]}" | bash "$here/classify-docs-only.sh")
echo "$report"
if [ "$(tail -n 1 <<<"$report")" = "docs_only=true" ]; then
  echo "build=false"
else
  echo "build=true"
fi
