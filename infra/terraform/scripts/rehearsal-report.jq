# What a firewall rehearsal's run sent where: the summary rehearsal.sh report
# writes the report from (with rehearsal-markdown.jq). Run with `jq -n`:
#
#   $run        [run.json of rehearsal.sh run]
#   $proxy      [the stand-in proxy's log lines of the run window]
#   $flows      [the VPC flow log lines of the run window, default format]
#   $allowlist  [the proxy_allowlist hosts of env.tfvars]
#   $app_cidrs  the app subnets' ranges
#   $s3_cidrs   the ranges of S3's prefix list (the gateway endpoint)
#   $vpc_cidr   the VPC's range
#   $ses_host   the SES endpoint the magic-link check must reach via the proxy

def ip2n: split(".") | map(tonumber) | .[0] * 16777216 + .[1] * 65536 + .[2] * 256 + .[3];
def is_ipv4: test("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$");
def in_cidr($cidr):
  ($cidr | split("/")) as [$net, $bits]
  | pow(2; 32 - ($bits | tonumber)) as $size
  | ((ip2n / $size) | floor) == (($net | ip2n) / $size | floor);
def in_any($cidrs): . as $ip | any($cidrs[]; . as $cidr | $ip | in_cidr($cidr));

# True when a proxy_allowlist entry lets the host through: the host itself, or
# a leading-dot domain that covers it (squid's dstdomain).
def listed($allow):
  . as $host
  | any($allow[]; . as $entry | $host == $entry or ($entry | startswith(".")) and (($host | endswith($entry)) or $host == $entry[1:]));

def protocol_name: {"1": "icmp", "6": "tcp", "17": "udp"}[.] // .;

# squid's native access.log line: time elapsed client code/status bytes method
# URL ... A CONNECT names host:port; any other method a full URL.
def proxy_requests:
  [ $proxy[0][]
    | capture("^(?<time>[0-9]+\\.[0-9]+)\\s+[0-9]+\\s+(?<client>\\S+)\\s+(?<code>[A-Z_]+)/(?<status>[0-9]{3})\\s+[0-9]+\\s+(?<method>[A-Z]+)\\s+(?<url>\\S+)")
    | .host = ((if .method == "CONNECT" then (.url | sub(":[0-9]+$"; "")) else ((.url | capture("^[a-z]+://(?<h>[^/:]+)") | .h) // .url) end) | ascii_downcase)
    | .denied = ((.code | test("DENIED")) or .status == "403")
  ];

# Flow log records, default format (version 2): version account interface src
# dst srcport dstport protocol packets bytes start end action status. The
# account and interface are dropped here and never reach the report.
def flow_records:
  [ $flows[0][]
    | split(" ")
    | select(length >= 14 and .[0] == "2")
    | {src: .[3], dst: .[4], dstport: .[6], protocol: (.[7] | protocol_name), action: .[12]}
    | select((.src | is_ipv4) and (.dst | is_ipv4))
  ];

def grouped: group_by([.src, .dst, .dstport, .protocol, .action]) | map(.[0] + {records: length}) | sort_by(-.records, .src, .dst);

proxy_requests as $requests
| ($requests | map(.host)) as $seen
| (flow_records | map(select(.src | in_any($app_cidrs)))) as $app
| any($requests[]; .host == $ses_host and (.denied | not)) as $ses_seen
| $run[0] as $run
| ($run.checks | map(
    if .id == "magic-link" and .status == "pass" and ($ses_seen | not) then
      .status = "fail" | .detail = "the request was accepted, but the proxy log shows no allowed request to \($ses_host)"
    elif .id == "magic-link" and .status == "pass" then
      .detail = "the request was accepted and \($ses_host) was reached through the proxy"
    else . end
  )) as $checks
| {
    env: $run.env,
    release_id: $run.release_id,
    started_at: $run.started_at,
    finished_at: $run.finished_at,
    checks: $checks,
    hosts: ($requests | group_by(.host) | map({
      host: .[0].host,
      requests: length,
      allowed: (map(select(.denied | not)) | length),
      denied: (map(select(.denied)) | length),
      listed: (.[0].host | listed($allowlist[0]))
    })),
    unparsed_proxy_lines: (($proxy[0] | length) - ($requests | length)),
    rejects: ($app | map(select(.action == "REJECT")) | grouped),
    direct: ($app | map(select(((.dst | in_cidr($vpc_cidr)) or (.dst | in_any($s3_cidrs))) | not)) | grouped),
    unlisted: ([$seen[] | select(listed($allowlist[0]) | not)] | unique),
    unexercised: [$allowlist[0][] | . as $entry | select(any($seen[]; listed([$entry])) | not)]
  }
| .passed = ([.checks[] | select(.status == "pass")] | length)
| .failed = ([.checks[] | select(.status == "fail")] | length)
| .not_run = ([.checks[] | select(.status == "not_run")] | length)
| .verdict = (
    if .failed > 0 or (.direct | length) > 0 or any(.hosts[]; .denied > 0) then "FAIL"
    elif .not_run > 0 then "INCOMPLETE"
    else "PASS" end
  )
