#!/usr/bin/env bash
# release-tfvars.sh — the one place that knows the shape of
# infra/terraform/envs/<env>/release.auto.tfvars: a release id and five images,
# each by digest.
#
#   release-tfvars.sh write <env> <release.json>
#       Prints the file for a release. release.json is what
#       .github/workflows/build-release.yml assembles:
#         { "release_id": "<commit sha>",
#           "images": { "<component>": { "ref": "<repository>@sha256:<digest>",
#                                        "tag": "<component>-<commit sha>", ... } } }
#
#   release-tfvars.sh verify <base> <head>
#       Checks that the change from commit <base> to commit <head> is a
#       release and nothing else:
#         - it changes exactly one envs/<env>/release.auto.tfvars file;
#         - the file sets the six values, every image by digest;
#         - the release id is a commit contained in <base>, the tip of the
#           default branch the pull request merges into;
#         - every image carries a signature made with $SIGNING_KEY for this
#           release id and this component. Only the image-push role can use
#           that key, and it can be assumed from the default branch only.
#       Needs `cosign` on PATH, registry credentials, and SIGNING_KEY (a
#       cosign key reference, for example awskms:///<key arn>).
#
#   release-tfvars.sh signed <commit> <env>
#       The last two checks of `verify` for envs/<env>/release.auto.tfvars as
#       it is in <commit>: the file is a release, its id is a commit contained
#       in <commit>, and every image is signed for it. The apply workflow runs
#       this on the commit it deploys. Same needs as `verify`.
#
#   release-tfvars.sh promote <commit> <from env> <to env>
#       Prints the release file of <to env> that deploys the release of
#       envs/<from env>/release.auto.tfvars as it is in <commit>: the same id
#       and the same five digests. The file is checked as `verify` checks it.
#
# exit: 0 when the file was written or the release verified, 1 when the
#       release is refused (the reason is on stderr), 2 on a usage error.
set -euo pipefail

components=(web worker memory-worker migrator agent)

# The rule of modules/ecs-task and modules/ecs-service in infra/terraform: an
# ECR image by digest. A tag can be moved to another image; a digest cannot.
image_by_digest='^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(\.cn)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'
commit_sha='^[0-9a-f]{40}$'
release_file='^infra/terraform/envs/([a-z0-9-]+)/release\.auto\.tfvars$'

refuse() {
  echo "release-tfvars: $*" >&2
  exit 1
}

usage() {
  echo "usage: release-tfvars.sh write <env> <release.json> | verify <base> <head> | signed <commit> <env> | promote <commit> <from env> <to env>" >&2
  exit 2
}

variable_of() { # component -> Terraform variable
  echo "image_${1//-/_}"
}

check_release_id() {
  [[ "$1" =~ $commit_sha ]] || refuse "release_id '$1' is not a full commit sha"
}

check_image() { # variable value
  [[ "$2" =~ $image_by_digest ]] ||
    refuse "$1 = '$2' does not name an ECR image by digest (<registry>/<repository>@sha256:<64 hex digits>); a tag is not accepted"
}

write() {
  local env_name=$1 file=$2 release_id component ref tag
  [[ "$env_name" =~ ^[a-z0-9-]+$ ]] || refuse "'$env_name' is not an environment name"
  [ -f "$file" ] || refuse "no such file: $file"

  release_id=$(jq -r '.release_id // "" | tostring' "$file") || refuse "$file is not JSON"
  check_release_id "$release_id"

  # Exactly the five components: a sixth would be silently dropped here, and
  # an image that is built but not deployed is a bug in the build.
  [ "$(jq -c '.images // {} | keys' "$file")" = "$(printf '%s\n' "${components[@]}" | jq -Rnc '[inputs] | sort')" ] ||
    refuse "images must be exactly: ${components[*]}"

  local -A refs=()
  for component in "${components[@]}"; do
    ref=$(jq -r --arg c "$component" '.images[$c].ref // "" | tostring' "$file")
    tag=$(jq -r --arg c "$component" '.images[$c].tag // "" | tostring' "$file")
    check_image "$(variable_of "$component")" "$ref"
    # The lifecycle rules of the ECR repositories (00-foundation) keep images
    # by these tag prefixes; an image tagged any other way is never expired.
    [ "$tag" = "$component-$release_id" ] ||
      refuse "$component is tagged '$tag', not '$component-$release_id'"
    refs[$component]=$ref
  done

  render "$env_name" "$release_id" "${refs[web]}" "${refs[worker]}" "${refs[memory-worker]}" \
    "${refs[migrator]}" "${refs[agent]}"
}

# The file itself. Arguments: env, release id, and the images in the order of
# $components.
render() {
  cat <<EOF
# The release deployed to $1: its id and its five images, each by
# digest. The release workflow (.github/workflows/build-release.yml) or a
# promotion (.github/workflows/promote.yml) replaces this whole file; nothing
# else belongs in it, and a deploy changes nothing else.

release_id = "$2"

image_web           = "$3"
image_worker        = "$4"
image_memory_worker = "$5"
image_migrator      = "$6"
image_agent         = "$7"
EOF
}

# Reads envs/<env>/release.auto.tfvars as it is in commit $1 (path $2) into
# the global `values`, refusing anything but the six values of a release with
# every image by digest.
declare -A values=()
parse() { # commit path
  local commit=$1 path=$2 line key value component variable
  values=()
  git cat-file -e "$commit:$path" 2>/dev/null || refuse "$path does not exist in $commit"
  # Every line is a comment, blank, or one of the six assignments, each once.
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([a-z_]+)[[:space:]]*=[[:space:]]*\"([^\"]*)\"$ ]] ||
      refuse "$path: unexpected line: $line"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [ -z "${values[$key]+set}" ] || refuse "$path: $key is set twice"
    values[$key]=$value
  done < <(git show "$commit:$path")

  local expected=(release_id)
  for component in "${components[@]}"; do
    expected+=("$(variable_of "$component")")
  done
  for key in "${expected[@]}"; do
    [ -n "${values[$key]+set}" ] || refuse "$path: $key is not set"
  done
  ((${#values[@]} == ${#expected[@]})) ||
    refuse "$path sets something other than: ${expected[*]}"

  check_release_id "${values[release_id]}"
  for component in "${components[@]}"; do
    variable=$(variable_of "$component")
    check_image "$variable" "${values[$variable]}"
  done
}

# The release id of `values` is a commit contained in $1, and every image is
# signed for it as its component. No transparency log is used
# (build-release.yml signs without one), so the signature is checked against
# the key alone.
check_signed() { # commit path
  local commit=$1 path=$2 release_id=${values[release_id]} component variable
  [ -n "${SIGNING_KEY:-}" ] || refuse "SIGNING_KEY is not set"
  git cat-file -e "$release_id^{commit}" 2>/dev/null ||
    refuse "release_id $release_id is not a commit of this repository"
  git merge-base --is-ancestor "$release_id" "$commit" ||
    refuse "release_id $release_id is not on the default branch"

  for component in "${components[@]}"; do
    variable=$(variable_of "$component")
    cosign verify --key "$SIGNING_KEY" --insecure-ignore-tlog=true \
      -a "release_id=$release_id" -a "component=$component" \
      "${values[$variable]}" >/dev/null ||
      refuse "$variable = ${values[$variable]} has no valid signature for release $release_id as '$component'"
    echo "signed  $variable = ${values[$variable]}"
  done
  echo "release $release_id verified for $path"
}

env_file() { # env -> path of its release file
  [[ "$1" =~ ^[a-z0-9-]+$ ]] || refuse "'$1' is not an environment name"
  echo "infra/terraform/envs/$1/release.auto.tfvars"
}

verify() {
  local base=$1 head=$2 path

  local changed=()
  while IFS= read -r -d '' path; do
    changed+=("$path")
  done < <(git diff --name-only --no-renames -z "$base" "$head")

  ((${#changed[@]} == 1)) ||
    refuse "a release changes exactly one file; this change touches ${#changed[@]}: ${changed[*]:-}"
  path=${changed[0]}
  [[ "$path" =~ $release_file ]] ||
    refuse "a release changes envs/<env>/release.auto.tfvars only; this change touches $path"

  parse "$head" "$path"
  check_signed "$base" "$path"
}

signed() {
  local commit=$1 path
  path=$(env_file "$2")
  parse "$commit" "$path"
  check_signed "$commit" "$path"
}

promote() {
  local commit=$1 from to
  from=$(env_file "$2")
  to=$(env_file "$3")
  [ "$2" != "$3" ] || refuse "a release is promoted from one environment to another, not to itself"
  git cat-file -e "$commit:$to" 2>/dev/null || refuse "$to does not exist in $commit"
  parse "$commit" "$from"
  render "$3" "${values[release_id]}" "${values[image_web]}" "${values[image_worker]}" \
    "${values[image_memory_worker]}" "${values[image_migrator]}" "${values[image_agent]}"
}

[ "$#" -ge 1 ] || usage
command=$1
shift
case "$command" in
  write)
    [ "$#" -eq 2 ] || usage
    write "$@"
    ;;
  verify)
    [ "$#" -eq 2 ] || usage
    verify "$@"
    ;;
  signed)
    [ "$#" -eq 2 ] || usage
    signed "$@"
    ;;
  promote)
    [ "$#" -eq 3 ] || usage
    promote "$@"
    ;;
  *) usage ;;
esac
