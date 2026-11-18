#!/usr/bin/env bash
# What 40-services plans inside its modules, read from the runs of
# services.tftest.hcl (see ../../../plan_checks.sh for how).
#
#   baseline                 a new environment, applied against the mock: the
#                            values production must receive, service by service
#   release                  the same environment with only the three images of
#                            release.auto.tfvars changed
#   proxy_and_internal_url   a proxy, an internal URL and the optional inputs
#
# No credentials, no real state, no AWS calls.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../../../plan_checks.sh
source "$here/../../../plan_checks.sh"

collect_plans "$here/.."

app='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"'
proxy_secret='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-GhIjKl"'
proxy_db_secret='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-db-MnOpQr"'
runtime='"arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/cmp_unit_agent-AbCdEfGhIj"'
browser='"arn:aws:bedrock-agentcore:us-east-1:111122223333:browser-custom/cmp_unit_studio_browser-AbCdEfGhIj"'
image='"111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000'

# The environment web and both workers share.
common='{
  NODE_ENV: "production",
  AWS_REGION: "us-east-1",
  BEDROCK_CLIENT: "real",
  RUNTIME: "bedrock",
  RUNTIME_V2_ENABLED: "1",
  RUNTIME_V2_DIRECT_MODEL_ID: "auto",
  NEXTAUTH_URL: "https://app.example.com",
  LEGACY_HOST_REDIRECT_FROM: "",
  HOSTNAME: "0.0.0.0",
  PORT: "3000",
  BEDROCK_INFERENCE_PROFILE_PREFIX: "us."
}'

# The fields of the app secret web and both workers read.
common_fields='[
  "BRAVE_SEARCH_API_KEY", "DATABASE_URL", "GITHUB_AUTH_CLIENT_ID", "GITHUB_AUTH_CLIENT_SECRET", "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "NEXTAUTH_SECRET", "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET", "OAUTH_ENCRYPTION_KEY", "SALESFORCE_CLIENT_ID", "SALESFORCE_CLIENT_SECRET",
  "WEB_SEARCH_PROVIDER"
]'

models='[
  "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-a-v1:0",
  "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.vendor.model-b",
  "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-a-v1:0",
  "arn:aws:bedrock:us-east-1::foundation-model/vendor.model-b",
  "arn:aws:bedrock:us-east-2::foundation-model/vendor.model-a-v1:0",
  "arn:aws:bedrock:us-east-2::foundation-model/vendor.model-b",
  "arn:aws:bedrock:us-west-2::foundation-model/vendor.model-a-v1:0",
  "arn:aws:bedrock:us-west-2::foundation-model/vendor.model-b"
]'

web=module.web.module.task
chat=module.chat_worker.module.task
memory=module.memory_worker.module.task
proxy=module.browser_proxy.module.task

# --- every service ----------------------------------------------------------------

check baseline "four services, four task definitions, four log groups, eight roles" '
  (of_type("aws_ecs_service") | length) == 4 and (of_type("aws_ecs_task_definition") | length) == 4
  and (of_type("aws_cloudwatch_log_group") | length) == 4 and (of_type("aws_iam_role") | length) == 8'
check baseline "no task gets a public IP" '
  of_type("aws_ecs_service") | all(.values.network_configuration[0].assign_public_ip == false)'
check baseline "every service runs on Fargate in the app subnets of the cluster" '
  of_type("aws_ecs_service") | all(
    .values.launch_type == "FARGATE"
    and .values.cluster == "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-unit-cluster"
    and (.values.network_configuration[0].subnets | sort) == ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"])'
check baseline "every deployment has the circuit breaker with rollback and waits for a steady service" '
  of_type("aws_ecs_service") | all(
    .values.deployment_circuit_breaker[0].enable == true and .values.deployment_circuit_breaker[0].rollback == true
    and .values.wait_for_steady_state == true and .values.enable_execute_command == false)'
check baseline "every image is given by digest" '
  of_type("aws_ecs_task_definition") | all(.values.container_definitions | fromjson | all(.image | test("@sha256:[0-9a-f]{64}$")))'
check baseline "every role is under /comparative/<env>/ with the workload boundary" '
  of_type("aws_iam_role") | all(
    .values.path == "/comparative/unit/"
    and .values.permissions_boundary == "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary")'
check baseline "every log group is /comparative/<env>/<service>, kept 30 days, encrypted" '
  (of_type("aws_cloudwatch_log_group") | all(
    .values.retention_in_days == 30
    and .values.kms_key_id == "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"))
  and ([of_type("aws_cloudwatch_log_group")[].values.name] | sort) == [
    "/comparative/unit/browser-proxy", "/comparative/unit/chat-worker", "/comparative/unit/memory-worker", "/comparative/unit/web"]'
check baseline "no policy allows a Bedrock action on a wildcard, and no model ARN has one" '
  [of_type("aws_iam_role_policy")[].values.policy | fromjson | .Statement[]
    | select([.Action] | flatten | any(startswith("bedrock:")))
    | [.Resource] | flatten | .[]] | (length > 0 and all(contains("*") | not))'
check baseline "the stack creates no security group and no rule (those belong to 10-network)" '
  [.resources[] | select(.type | test("security_group"))] | length == 0'

# --- web --------------------------------------------------------------------------

check baseline "web: image_web, the image's own command, 512/1024, port 3000" "
  container(\"$web\") as \$c | resource(\"$web.aws_ecs_task_definition.this\") as \$t
  | \$c.image == ${image}a1\" and (\$c | has(\"command\") | not) and \$t.cpu == \"512\" and \$t.memory == \"1024\"
  and \$c.portMappings == [{containerPort: 3000, hostPort: 3000, protocol: \"tcp\"}]"
check baseline "web: the common environment plus its own" "
  environment(\"$web\") == ($common + {
    CHAT_RUN_IN_PROCESS_WORKER: \"0\",
    MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: \"0\",
    INVITE_EMAIL_PROVIDER: \"ses\",
    INVITE_EMAIL_FROM: \"no-reply@app.example.com\",
    INVITE_EMAIL_AWS_REGION: \"us-east-1\",
    AGENTCORE_BROWSER_ENABLED: \"1\",
    AGENTCORE_BROWSER_ID: \"cmp_unit_studio_browser-AbCdEfGhIj\",
    AGENTCORE_BROWSER_PROXY_HOST: \"browser-proxy.unit.comparative.internal\",
    AGENTCORE_BROWSER_PROXY_PORT: \"3128\",
    AGENTCORE_BROWSER_PROXY_SECRET_ARN: $proxy_secret,
    STUDIO_SANDBOX_DNS_SUFFIX: \".unit.comparative.internal\"
  })"
check baseline "web: the fifteen app-secret fields and GITHUB_WEBHOOK_SECRET, each by reference" "
  secrets(\"$web\") == ([$common_fields[], \"GITHUB_WEBHOOK_SECRET\"] | map({(.): ($app + \":\" + . + \"::\")}) | add)"
check baseline "web: the execution role reads the app secret only" "
  statement(\"$web.aws_iam_role_policy.execution\"; \"ReadTaskSecrets\").Resource == [$app]"
check baseline "web: behind the target group on port 3000, at least 100 % healthy" "
  resource(\"module.web.aws_ecs_service.autoscaled[0]\") as \$s
  | \$s.name == \"cmp-unit-web\" and \$s.deployment_minimum_healthy_percent == 100
  and (\$s.load_balancer | length) == 1 and \$s.load_balancer[0].container_name == \"web\"
  and \$s.load_balancer[0].container_port == 3000 and \$s.load_balancer[0].target_group_arn
    == \"arn:aws:elasticloadbalancing:us-east-1:111122223333:targetgroup/cmp-unit-web/0123456789abcdef\"
  and \$s.network_configuration[0].security_groups == [\"sg-0000000000000web1\"]"
check baseline "web: autoscaling web_min..web_max at 60 % CPU, 60 s out, 300 s in" '
  resource("module.web.aws_appautoscaling_target.this[0]") as $t
  | resource("module.web.aws_appautoscaling_policy.cpu[0]").target_tracking_scaling_policy_configuration[0] as $p
  | $t.min_capacity == 2 and $t.max_capacity == 4 and $t.resource_id == "service/cmp-unit-cluster/cmp-unit-web"
  and $p.target_value == 60 and $p.scale_out_cooldown == 60 and $p.scale_in_cooldown == 300
  and $p.predefined_metric_specification[0].predefined_metric_type == "ECSServiceAverageCPUUtilization"'
check baseline "web: only web is autoscaled" '
  (of_type("aws_appautoscaling_target") | length) == 1 and (of_type("aws_appautoscaling_policy") | length) == 1'
check baseline "web: may invoke exactly the listed models" "
  statement(\"$web.aws_iam_role_policy.task[0]\"; \"InvokeModels\")
  | .Action == [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"] and (.Resource | sort) == ($models | sort)"
check baseline "web: may send email from the one SES identity" "
  statement(\"$web.aws_iam_role_policy.task[0]\"; \"SendInviteEmail\")
  | .Action == \"ses:SendEmail\" and .Resource == \"arn:aws:ses:us-east-1:111122223333:identity/app.example.com\""
check baseline "web: the five Browser session actions on the one browser" "
  statement(\"$web.aws_iam_role_policy.task[0]\"; \"UseStudioBrowser\")
  | .Resource == $browser and (.Action | sort) == [
      \"bedrock-agentcore:ConnectBrowserLiveViewStream\", \"bedrock-agentcore:GetBrowserSession\",
      \"bedrock-agentcore:InvokeBrowser\", \"bedrock-agentcore:StartBrowserSession\",
      \"bedrock-agentcore:StopBrowserSession\"]"
# Carried over from ecs-cdk-browser.test.ts: the policy that lets web start a
# Browser session also lets it read the proxy credentials that session uses.
check baseline "web: the caller of StartBrowserSession can read the browser-proxy credentials" "
  statements(\"$web.aws_iam_role_policy.task[0]\") as \$all
  | (\$all | any([.Action] | flatten | index(\"bedrock-agentcore:StartBrowserSession\")))
  and (statement(\"$web.aws_iam_role_policy.task[0]\"; \"ReadBrowserProxyCredentials\")
    | (.Action | index(\"secretsmanager:GetSecretValue\")) != null and .Resource == $proxy_secret)
  and (statement(\"$web.aws_iam_role_policy.task[0]\"; \"DecryptBrowserProxyCredentials\")
    | .Action == \"kms:Decrypt\" and .Resource == \"arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002\")"
check baseline "web: may invoke the runtime and its endpoints" "
  statement(\"$web.aws_iam_role_policy.task[0]\"; \"InvokeAgentRuntime\")
  | .Action == [\"bedrock-agentcore:InvokeAgentRuntime\", \"bedrock-agentcore:InvokeAgentRuntimeForUser\"]
  and .Resource == [$runtime, ($runtime + \"/*\")]"
check baseline "web: nothing else" "
  [statements(\"$web.aws_iam_role_policy.task[0]\")[].Sid] == [
    \"InvokeModels\", \"InvokeAgentRuntime\", \"SendInviteEmail\", \"UseStudioBrowser\",
    \"ReadBrowserProxyCredentials\", \"DecryptBrowserProxyCredentials\"]"

# --- chat-worker ------------------------------------------------------------------

check baseline "chat-worker: image_worker, worker:chat-runs, 256/512, no port" "
  container(\"$chat\") as \$c | resource(\"$chat.aws_ecs_task_definition.this\") as \$t
  | \$c.image == ${image}a2\" and \$c.command == [\"pnpm\", \"--filter\", \"@ai-workspace/web\", \"worker:chat-runs\"]
  and \$t.cpu == \"256\" and \$t.memory == \"512\" and \$c.portMappings == []"
check baseline "chat-worker: the common environment, on the AgentCore runtime read from SSM" "
  environment(\"$chat\") == ($common + {
    RUNTIME: \"agentcore\",
    AGENTCORE_RUNTIME_ARN: $runtime,
    MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: \"0\"
  })"
check baseline "chat-worker: the fifteen app-secret fields, without GITHUB_WEBHOOK_SECRET" "
  secrets(\"$chat\") == ($common_fields | map({(.): ($app + \":\" + . + \"::\")}) | add)"
check baseline "chat-worker: chat_worker_count tasks, may drop to 0 % during a deployment, worker security group" '
  resource("module.chat_worker.aws_ecs_service.fixed[0]") as $s
  | $s.name == "cmp-unit-chat-worker" and $s.desired_count == 1 and $s.deployment_minimum_healthy_percent == 0
  and $s.load_balancer == [] and $s.service_registries == []
  and $s.network_configuration[0].security_groups == ["sg-0000000000worker1"]'
check baseline "chat-worker: may invoke the models and the runtime, nothing else" "
  statements(\"$chat.aws_iam_role_policy.task[0]\") as \$all
  | [\$all[].Sid] == [\"InvokeModels\", \"InvokeAgentRuntime\"]
  and (\$all[0].Resource | sort) == ($models | sort) and \$all[1].Resource == [$runtime, ($runtime + \"/*\")]"

# --- memory-worker ----------------------------------------------------------------

check baseline "memory-worker: image_memory_worker, worker:memory-capture, 256/512, no port" "
  container(\"$memory\") as \$c | resource(\"$memory.aws_ecs_task_definition.this\") as \$t
  | \$c.image == ${image}a3\" and \$c.command == [\"pnpm\", \"--filter\", \"@ai-workspace/web\", \"worker:memory-capture\"]
  and \$t.cpu == \"256\" and \$t.memory == \"512\" and \$c.portMappings == []"
check baseline "memory-worker: the common environment and the scheduler switch" "
  environment(\"$memory\") == ($common + {MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: \"0\"})"
check baseline "memory-worker: the fifteen app-secret fields" "
  secrets(\"$memory\") == ($common_fields | map({(.): ($app + \":\" + . + \"::\")}) | add)"
check baseline "memory-worker: one task, may drop to 0 % during a deployment, worker security group" '
  resource("module.memory_worker.aws_ecs_service.fixed[0]") as $s
  | $s.name == "cmp-unit-memory-worker" and $s.desired_count == 1 and $s.deployment_minimum_healthy_percent == 0
  and $s.load_balancer == [] and $s.network_configuration[0].security_groups == ["sg-0000000000worker1"]'
check baseline "memory-worker: may invoke the models, nothing else" "
  statements(\"$memory.aws_iam_role_policy.task[0]\") as \$all
  | [\$all[].Sid] == [\"InvokeModels\"] and (\$all[0].Resource | sort) == ($models | sort)"

# --- browser-proxy ----------------------------------------------------------------

check baseline "browser-proxy: image_worker, browser:egress-proxy, 256/512, port 3128" "
  container(\"$proxy\") as \$c | resource(\"$proxy.aws_ecs_task_definition.this\") as \$t
  | \$c.image == ${image}a2\" and \$c.command == [\"pnpm\", \"--filter\", \"@ai-workspace/web\", \"browser:egress-proxy\"]
  and \$t.cpu == \"256\" and \$t.memory == \"512\"
  and \$c.portMappings == [{containerPort: 3128, hostPort: 3128, protocol: \"tcp\"}]"
check baseline "browser-proxy: its own three variables, not the common environment" "
  environment(\"$proxy\") == {NODE_ENV: \"production\", AWS_REGION: \"us-east-1\", BROWSER_PROXY_PORT: \"3128\"}"
check baseline "browser-proxy: its own database login and the generated credentials, never the app secret" "
  secrets(\"$proxy\") == {
    DATABASE_URL: ($proxy_db_secret + \":DATABASE_URL::\"),
    BROWSER_PROXY_USERNAME: ($proxy_secret + \":username::\"),
    BROWSER_PROXY_PASSWORD: ($proxy_secret + \":password::\")
  }
  and statement(\"$proxy.aws_iam_role_policy.execution\"; \"ReadTaskSecrets\").Resource == [$proxy_db_secret, $proxy_secret]"
check baseline "browser-proxy: a TCP health check on its port" "
  container(\"$proxy\").healthCheck
  | .command[0] == \"CMD-SHELL\" and (.command[1] | contains(\"connect(3128,'127.0.0.1')\"))
  and .interval == 30 and .timeout == 5 and .retries == 3 and .startPeriod == 15"
check baseline "browser-proxy: no AWS permissions" "
  [.resources[] | select(.address | startswith(\"$proxy.aws_iam_role_policy.task\"))] | length == 0"
check baseline "browser-proxy: one task, registered as browser-proxy.<namespace>, browser_proxy security group" '
  resource("module.browser_proxy.aws_ecs_service.fixed[0]") as $s
  | resource("module.browser_proxy.aws_service_discovery_service.this[0]") as $d
  | $s.name == "cmp-unit-browser-proxy" and $s.desired_count == 1 and $s.deployment_minimum_healthy_percent == 100
  and $s.load_balancer == [] and ($s.service_registries | length) == 1
  and $s.network_configuration[0].security_groups == ["sg-00000000000proxy1"]
  and $d.name == "browser-proxy" and $d.dns_config[0].namespace_id == "ns-0123456789abcdef"
  and $d.dns_config[0].dns_records[0].type == "A"'
check baseline "only browser-proxy has a Cloud Map name" '
  of_type("aws_service_discovery_service") | length == 1'

# --- a routine deploy --------------------------------------------------------------

# The mock keeps a task definition's ARN across the change, so the services,
# which would move to the new revision, show no change here. The check allows
# them and nothing else.
check release "changing only the images changes task definitions and services, nothing else" '
  changed | (length > 0 and all(.type == "aws_ecs_task_definition" or .type == "aws_ecs_service"))'
check release "all four task definitions take their new image" "
  ([changed[] | select(.type == \"aws_ecs_task_definition\") | .address] | sort) == ([
    \"$web\", \"$chat\", \"$memory\", \"$proxy\"] | map(. + \".aws_ecs_task_definition.this\") | sort)
  and container(\"$web\").image == ${image}b1\" and container(\"$chat\").image == ${image}b2\"
  and container(\"$memory\").image == ${image}b3\" and container(\"$proxy\").image == ${image}b2\""

# --- a proxy, an internal URL, the optional inputs ---------------------------------

check proxy_and_internal_url "web and both workers get the proxy, the internal URL and the extra environment" "
  [environment(\"$web\"), environment(\"$chat\"), environment(\"$memory\")] | all(
    .HTTPS_PROXY == \"http://proxy.corp.example:3128\" and .HTTP_PROXY == \"http://proxy.corp.example:3128\"
    and .NO_PROXY == \"169.254.170.2,localhost,127.0.0.1\"
    and .INTERNAL_BASE_URL == \"https://internal.app.example.com\"
    and .LEGACY_HOST_REDIRECT_FROM == \"old.example.com\" and .WEB_SEARCH_PROVIDER == \"none\")"
check baseline "without a proxy or an internal URL none of those variables is set" "
  [environment(\"$web\"), environment(\"$chat\"), environment(\"$memory\")] | all(
    (has(\"HTTPS_PROXY\") or has(\"HTTP_PROXY\") or has(\"NO_PROXY\") or has(\"INTERNAL_BASE_URL\")) | not)"
check proxy_and_internal_url "what a service sets for itself wins over the extra environment" "
  environment(\"$chat\").RUNTIME == \"agentcore\""
check proxy_and_internal_url "browser-proxy still gets its own three variables only" "
  environment(\"$proxy\") == {NODE_ENV: \"production\", AWS_REGION: \"us-east-1\", BROWSER_PROXY_PORT: \"3128\"}"
check proxy_and_internal_url "agentcore_browser_enabled = false turns the browser off in web" "
  environment(\"$web\").AGENTCORE_BROWSER_ENABLED == \"0\""
check proxy_and_internal_url "an optional app-secret field goes to web only" "
  secrets(\"$web\").OIDC_CLIENT_SECRET == ($app + \":OIDC_CLIENT_SECRET::\")
  and (secrets(\"$chat\") | has(\"OIDC_CLIENT_SECRET\") | not) and (secrets(\"$memory\") | has(\"OIDC_CLIENT_SECRET\") | not)"

finish
