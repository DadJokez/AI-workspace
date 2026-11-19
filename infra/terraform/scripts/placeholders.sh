#!/usr/bin/env bash
# placeholders.sh <env dir> — the values of envs/<env>/ that still carry the
# REPLACE_ME marker. tf.sh refuses to run while there is one; the plan and
# apply workflows skip such an environment, which has not been set up yet.
#
# exit: 0 none (nothing printed), 1 some (each printed as file:line:text),
#       2 usage error or a missing file.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: placeholders.sh <env dir>" >&2; exit 2; }
env_dir=$1

files=()
for file in backend.hcl env.tfvars release.auto.tfvars; do
  [ -f "$env_dir/$file" ] || { echo "placeholders.sh: missing $env_dir/$file" >&2; exit 2; }
  files+=("$env_dir/$file")
done

# Comment lines may mention the marker; a value that still carries it may not.
if grep -n 'REPLACE_ME' "${files[@]}" | grep -v '^[^:]*:[0-9]*:[[:space:]]*#'; then
  exit 1
fi
exit 0
