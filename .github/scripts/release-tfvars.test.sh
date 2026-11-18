#!/usr/bin/env bash
# Fixtures for release-tfvars.sh: what the release workflow may write into
# envs/<env>/release.auto.tfvars, and what a release pull request must be.
#
# The refusals matter most: a tag where a digest is required, a change that
# carries anything beside the release file, an image nobody signed, and a
# release id that is not on the default branch must each be refused.
#
# `verify` runs against a throwaway git repository and a stand-in `cosign`
# that knows which image was signed for which release and component; the real
# signature check needs a registry and the signing key.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
script="$PWD/.github/scripts/release-tfvars.sh"
pass=0
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ok() {
  echo "  ok   $1"
  pass=$((pass + 1))
}
bad() { # name detail
  echo "  FAIL $1"
  printf '%s\n' "$2" | sed 's/^/       /'
  fail=$((fail + 1))
}

# name expected-exit expected-text command...
# Passes when the command exits as expected and its output contains the text.
check() {
  local name="$1" want_status="$2" want_text="$3" out status
  shift 3
  out="$("$@" 2>&1)"
  status=$?
  if [ "$status" = "$want_status" ] && [[ "$out" == *"$want_text"* ]]; then
    ok "$name"
  else
    bad "$name" "want exit $want_status containing '$want_text'; got exit $status:
$out"
  fi
}

registry="123456789012.dkr.ecr.us-east-1.amazonaws.com"
app="$registry/cmp-personal-stage-app"
agent="$registry/cmp-personal-stage-agent"
digest() { printf 'sha256:%064d' "$1"; }

# ---------------------------------------------------------------- write ------

release_json() { # release-id [jq filter applied to the valid document]
  local id="$1" filter="${2:-.}"
  jq -n --arg id "$id" --arg app "$app" --arg agent "$agent" \
    --arg d1 "$(digest 1)" --arg d2 "$(digest 2)" --arg d3 "$(digest 3)" \
    --arg d4 "$(digest 4)" --arg d5 "$(digest 5)" '
    def image($component; $ref): {
      ref: $ref, tag: "\($component)-\($id)",
      sbom_artifact: "sbom-\($component)", scan_artifact: "scan-\($component)"
    };
    { release_id: $id,
      images: {
        "web": image("web"; "\($app)@\($d1)"),
        "worker": image("worker"; "\($app)@\($d2)"),
        "memory-worker": image("memory-worker"; "\($app)@\($d3)"),
        "migrator": image("migrator"; "\($app)@\($d4)"),
        "agent": image("agent"; "\($agent)@\($d5)")
      } }' | jq "$filter"
}

id_a=$(printf 'a%.0s' {1..40})

echo "write:"

release_json "$id_a" > "$tmp/release.json"
cat > "$tmp/expected.tfvars" <<EOF
# The release deployed to personal-stage: its id and its five images, each by
# digest. The release workflow (.github/workflows/build-release.yml) replaces
# this whole file; nothing else belongs in it, and a deploy changes nothing
# else.

release_id = "$id_a"

image_web           = "$app@$(digest 1)"
image_worker        = "$app@$(digest 2)"
image_memory_worker = "$app@$(digest 3)"
image_migrator      = "$app@$(digest 4)"
image_agent         = "$agent@$(digest 5)"
EOF
if bash "$script" write personal-stage "$tmp/release.json" > "$tmp/actual.tfvars" 2> "$tmp/err" &&
  diff -u "$tmp/expected.tfvars" "$tmp/actual.tfvars" > "$tmp/diff"; then
  ok "a release of five digests is written exactly"
else
  bad "a release of five digests is written exactly" "$(cat "$tmp/err" "$tmp/diff" 2>/dev/null)"
fi

write_refused() { # name expected-text jq-filter [release-id]
  release_json "${4:-$id_a}" "$3" > "$tmp/bad.json"
  check "$1" 1 "$2" bash "$script" write personal-stage "$tmp/bad.json"
}

write_refused "a tag instead of a digest is refused" "a tag is not accepted" \
  ".images.web.ref = \"$app:web-$id_a\""
write_refused "a tag and a digest together are refused" "a tag is not accepted" \
  ".images.web.ref = \"$app:web-$id_a@$(digest 1)\""
write_refused "a short digest is refused" "a tag is not accepted" \
  ".images.agent.ref = \"$agent@sha256:abc123\""
write_refused "an image outside ECR is refused" "a tag is not accepted" \
  ".images.worker.ref = \"docker.io/library/node@$(digest 2)\""
write_refused "a missing component is refused" "images must be exactly" \
  'del(.images.migrator)'
write_refused "an extra component is refused" "images must be exactly" \
  '.images.extra = .images.web'
write_refused "a tag outside the lifecycle prefixes is refused" "is tagged 'latest'" \
  '.images.web.tag = "latest"'
write_refused "a short release id is refused" "is not a full commit sha" '.' abc1234
check "an unknown environment name is refused" 1 "is not an environment name" \
  bash "$script" write 'personal stage' "$tmp/release.json"
check "a wrong argument count is a usage error" 2 "usage:" bash "$script" write personal-stage

# --------------------------------------------------------------- verify ------

# A stand-in cosign: `cosign verify ... -a release_id=<id> -a component=<c> <ref>`
# succeeds only when "<ref> <id> <c>" is a line of $SIGNED.
mkdir "$tmp/bin"
cat > "$tmp/bin/cosign" <<'EOF'
#!/usr/bin/env bash
[ "$1" = verify ] || { echo "cosign stand-in: unexpected command $1" >&2; exit 2; }
shift
key="" release_id="" component="" ignore_tlog=""
while [ "$#" -gt 1 ]; do
  case "$1" in
    --key) key=$2; shift ;;
    --insecure-ignore-tlog=true) ignore_tlog=yes ;;
    -a)
      case "$2" in
        release_id=*) release_id=${2#release_id=} ;;
        component=*) component=${2#component=} ;;
      esac
      shift
      ;;
    *) echo "cosign stand-in: unexpected argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$key" = "awskms:///test-key" ] && [ "$ignore_tlog" = yes ] ||
  { echo "cosign stand-in: wrong key or flags" >&2; exit 2; }
grep -qxF "$1 $release_id $component" "$SIGNED" ||
  { echo "Error: no signatures found" >&2; exit 10; }
EOF
chmod +x "$tmp/bin/cosign"

repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email release-test@example.invalid
git -C "$repo" config user.name "release test"
git -C "$repo" config commit.gpgsign false
file=infra/terraform/envs/personal-stage/release.auto.tfvars
mkdir -p "$repo/$(dirname "$file")" "$repo/apps"
echo "# no release yet" > "$repo/$file"
echo "one" > "$repo/apps/code.txt"
git -C "$repo" add -A
git -C "$repo" commit -q -m "built commit"
built=$(git -C "$repo" rev-parse HEAD)
echo "two" > "$repo/apps/code.txt"
git -C "$repo" commit -q -am "later commit on main"
main=$(git -C "$repo" rev-parse HEAD)

# A commit that never reached main.
git -C "$repo" checkout -q -b feature "$built"
echo "feature" > "$repo/apps/code.txt"
git -C "$repo" commit -q -am "commit on a feature branch"
off_main=$(git -C "$repo" rev-parse HEAD)

# The five images of a release, signed for it.
sign_all() { # release-id -> lines of $SIGNED
  local id="$1"
  printf '%s\n' \
    "$app@$(digest 1) $id web" \
    "$app@$(digest 2) $id worker" \
    "$app@$(digest 3) $id memory-worker" \
    "$app@$(digest 4) $id migrator" \
    "$agent@$(digest 5) $id agent"
}

# Makes a release pull request head on top of main: writes the release file
# for <release-id>, then runs the optional edit command in the work tree.
make_head() { # release-id [edit command...]
  local id="$1"
  shift
  git -C "$repo" checkout -q --detach "$main"
  release_json "$id" > "$tmp/head.json"
  bash "$script" write personal-stage "$tmp/head.json" > "$repo/$file"
  if (($# > 0)); then (cd "$repo" && "$@"); fi
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "release"
  git -C "$repo" rev-parse HEAD
}

verify_case() { # name expected-exit expected-text head signed-lines
  printf '%s\n' "$5" > "$tmp/signed"
  check "$1" "$2" "$3" env -C "$repo" PATH="$tmp/bin:$PATH" SIGNED="$tmp/signed" \
    SIGNING_KEY="awskms:///test-key" bash "$script" verify "$main" "$4"
}

echo "verify:"

head=$(make_head "$built")
verify_case "a signed release of a commit on main is accepted" 0 \
  "release $built verified" "$head" "$(sign_all "$built")"

verify_case "an unsigned digest is refused" 1 "image_migrator" "$head" \
  "$(sign_all "$built" | grep -v ' migrator$')"

verify_case "a digest signed for another release is refused" 1 "has no valid signature" \
  "$head" "$(sign_all "$off_main")"

verify_case "a digest signed as another component is refused" 1 "image_worker" "$head" \
  "$(sign_all "$built" | sed 's/ worker$/ web/')"

extra=$(make_head "$built" sh -c 'echo three > apps/code.txt')
verify_case "an extra file in the diff is refused" 1 "exactly one file" "$extra" \
  "$(sign_all "$built")"

other=$(make_head "$built" sh -c "git checkout -q $main -- $file && echo x > infra/terraform/envs/personal-stage/env.tfvars")
verify_case "a change to another file alone is refused" 1 "release.auto.tfvars only" \
  "$other" "$(sign_all "$built")"

foreign=$(make_head "$off_main")
verify_case "a release of a commit that is not on main is refused, signed or not" 1 \
  "is not on the default branch" "$foreign" "$(sign_all "$off_main")"

unknown=$(printf 'b%.0s' {1..40})
ghost=$(make_head "$unknown")
verify_case "a release id that is no commit is refused" 1 "is not a commit" "$ghost" \
  "$(sign_all "$unknown")"

tagged=$(make_head "$built" sed -i "s|^image_web .*|image_web           = \"$app:web-$built\"|" "$file")
verify_case "a tag instead of a digest is refused" 1 "a tag is not accepted" "$tagged" \
  "$(sign_all "$built")"

added=$(make_head "$built" sh -c "echo 'web_min = 5' >> $file")
verify_case "an assignment that is not part of a release is refused" 1 "unexpected line" \
  "$added" "$(sign_all "$built")"

renamed=$(make_head "$built" sh -c "echo 'image_extra = \"x\"' >> $file")
verify_case "a seventh value is refused" 1 "sets something other than" "$renamed" \
  "$(sign_all "$built")"

twice=$(make_head "$built" sh -c "echo 'release_id = \"$off_main\"' >> $file")
verify_case "a value set twice is refused" 1 "is set twice" "$twice" "$(sign_all "$built")"

dropped=$(make_head "$built" sed -i '/^image_agent/d' "$file")
verify_case "a missing image is refused" 1 "image_agent is not set" "$dropped" \
  "$(sign_all "$built")"

printf '%s\n' "$(sign_all "$built")" > "$tmp/signed"
check "a missing signing key is refused" 1 "SIGNING_KEY is not set" \
  env -C "$repo" -u SIGNING_KEY PATH="$tmp/bin:$PATH" SIGNED="$tmp/signed" \
  bash "$script" verify "$main" "$head"

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
