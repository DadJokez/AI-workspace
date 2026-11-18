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
  echo "usage: release-tfvars.sh write <env> <release.json> | verify <base> <head>" >&2
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

  cat <<EOF
# The release deployed to $env_name: its id and its five images, each by
# digest. The release workflow (.github/workflows/build-release.yml) replaces
# this whole file; nothing else belongs in it, and a deploy changes nothing
# else.

release_id = "$release_id"

image_web           = "${refs[web]}"
image_worker        = "${refs[worker]}"
image_memory_worker = "${refs[memory-worker]}"
image_migrator      = "${refs[migrator]}"
image_agent         = "${refs[agent]}"
EOF
}

verify() {
  local base=$1 head=$2 path line key value component variable
  [ -n "${SIGNING_KEY:-}" ] || refuse "SIGNING_KEY is not set"

  local changed=()
  while IFS= read -r -d '' path; do
    changed+=("$path")
  done < <(git diff --name-only --no-renames -z "$base" "$head")

  ((${#changed[@]} == 1)) ||
    refuse "a release changes exactly one file; this change touches ${#changed[@]}: ${changed[*]:-}"
  path=${changed[0]}
  [[ "$path" =~ $release_file ]] ||
    refuse "a release changes envs/<env>/release.auto.tfvars only; this change touches $path"

  # Every line is a comment, blank, or one of the six assignments, each once.
  local -A values=()
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    [[ "$line" =~ ^([a-z_]+)[[:space:]]*=[[:space:]]*\"([^\"]*)\"$ ]] ||
      refuse "$path: unexpected line: $line"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    [ -z "${values[$key]+set}" ] || refuse "$path: $key is set twice"
    values[$key]=$value
  done < <(git show "$head:$path")

  local expected=(release_id)
  for component in "${components[@]}"; do
    expected+=("$(variable_of "$component")")
  done
  for key in "${expected[@]}"; do
    [ -n "${values[$key]+set}" ] || refuse "$path: $key is not set"
  done
  ((${#values[@]} == ${#expected[@]})) ||
    refuse "$path sets something other than: ${expected[*]}"

  local release_id=${values[release_id]}
  check_release_id "$release_id"
  for component in "${components[@]}"; do
    variable=$(variable_of "$component")
    check_image "$variable" "${values[$variable]}"
  done

  git cat-file -e "$release_id^{commit}" 2>/dev/null ||
    refuse "release_id $release_id is not a commit of this repository"
  git merge-base --is-ancestor "$release_id" "$base" ||
    refuse "release_id $release_id is not on the default branch"

  # No transparency log is used (build-release.yml signs without one), so the
  # signature is checked against the key alone.
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
  *) usage ;;
esac
