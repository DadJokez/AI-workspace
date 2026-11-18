#!/usr/bin/env bash
# The one way to run a stack, for humans and the pipeline alike.
#
#   infra/terraform/tf.sh <env> <stack> <plan|apply|destroy|output> [extra args]
#
# It initialises stacks/<stack> against the state of <env> and runs the command
# with that environment's variable files.
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <env> <stack> <plan|apply|destroy|output> [extra args]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage
env_name=$1
stack=$2
command=$3
shift 3

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_dir="$root/envs/$env_name"
stack_dir="$root/stacks/$stack"

case "$command" in
  plan | apply | destroy | output) ;;
  *) usage ;;
esac

[ -d "$env_dir" ] || { echo "tf.sh: unknown environment '$env_name' (no $env_dir)" >&2; exit 2; }
[ -d "$stack_dir" ] || { echo "tf.sh: unknown stack '$stack' (no $stack_dir)" >&2; exit 2; }

for file in backend.hcl env.tfvars release.auto.tfvars; do
  [ -f "$env_dir/$file" ] || { echo "tf.sh: missing $env_dir/$file" >&2; exit 2; }
done

# Comment lines may mention the marker; a value that still carries it may not.
if grep -n 'REPLACE_ME' "$env_dir/backend.hcl" "$env_dir/env.tfvars" "$env_dir/release.auto.tfvars" | grep -v '^[^:]*:[0-9]*:[[:space:]]*#' >&2; then
  echo "tf.sh: envs/$env_name still has the placeholder values listed above; replace them first." >&2
  exit 2
fi

# -reconfigure: one stack directory serves every environment, so the backend
# settings left by the previous run must never be reused.
terraform -chdir="$stack_dir" init -input=false -reconfigure \
  -backend-config="$env_dir/backend.hcl" \
  -backend-config="key=$env_name/$stack.tfstate"

if [ "$command" = output ]; then
  exec terraform -chdir="$stack_dir" output "$@"
fi

exec terraform -chdir="$stack_dir" "$command" \
  -var-file="$env_dir/env.tfvars" \
  -var-file="$env_dir/release.auto.tfvars" \
  "$@"
