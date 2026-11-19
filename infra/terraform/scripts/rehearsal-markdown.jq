# docs/security/FIREWALL_REHEARSAL_<date>.md from the summary of
# rehearsal-report.jq. Run with `jq -r --arg date <YYYY-MM-DD>`.

def cell: tostring | gsub("\\|"; "\\|") | gsub("\n"; " ");
def table($head; $rows):
  if ($rows | length) == 0 then "None."
  else
    ("| " + ($head | join(" | ")) + " |"),
    ("|" + ($head | map("---") | join("|")) + "|"),
    ($rows[] | "| " + (map(cell) | join(" | ")) + " |")
  end;
def status_word: {"pass": "pass", "fail": "**fail**", "not_run": "not run"}[.];

"# Firewall rehearsal \($date)",
"",
"<!-- Written by `infra/terraform/scripts/rehearsal.sh report`. The procedure is in infra/terraform/README.md, \"Firewall rehearsal\". -->",
"",
"Environment `\(.env)`, release `\(.release_id)`, run from \(.started_at | todate) to \(.finished_at | todate). Flow logs were read from ten minutes before to ten minutes after that window, the proxy log for the window itself.",
"",
"**Result: \(.verdict).** \(.passed) of \(.checks | length) checks passed, \(.failed) failed, \(.not_run) not run. A check that was not run did not pass.",
"",
"## Checks",
"",
table(["#", "Check", "Result", "Detail"]; [.checks | to_entries[] | [(.key + 1), .value.name, (.value.status | status_word), .value.detail]]),
"",
"## Destinations seen at the proxy",
"",
"Every host the stand-in proxy was asked for. \"Listed\" is whether `proxy_allowlist` (the egress inventory's proxy list) contains it.",
"",
table(["Host", "Requests", "Allowed", "Denied", "Listed"]; [.hosts[] | ["`\(.host)`", .requests, .allowed, .denied, (if .listed then "yes" else "**no**" end)]]),
(if .unparsed_proxy_lines > 0 then "", "\(.unparsed_proxy_lines) line(s) of the proxy log were not requests (squid's own messages) and are not counted." else empty end),
"",
"## Rejected flows from the app subnets",
"",
table(["Source", "Destination", "Port", "Protocol", "Records"]; [.rejects[] | [.src, .dst, .dstport, .protocol, .records]]),
"",
"## Direct-to-internet attempts from the app subnets",
"",
"Flows from an app subnet to an address outside the VPC that is not S3's (the gateway endpoint). The app subnets have no route out; every one of these is a connection that ignored the proxy.",
"",
table(["Source", "Destination", "Port", "Protocol", "Action", "Records"]; [.direct[] | [.src, .dst, .dstport, .protocol, .action, .records]]),
"",
"## Deviations from EGRESS_INVENTORY.md",
"",
"- Hosts requested at the proxy that the inventory does not list for this deployment: \(if (.unlisted | length) == 0 then "none" else (.unlisted | map("`\(.)`") | join(", ")) end).",
"- Direct connections, which the inventory routes through the proxy or a VPC endpoint: \(.direct | length).",
"- Listed hosts this run did not exercise (not a failure; the checks that were not run reach some of them): \(if (.unexercised | length) == 0 then "none" else (.unexercised | map("`\(.)`") | join(", ")) end).",
"",
"Every failure above becomes an issue."
