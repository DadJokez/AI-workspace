#!/usr/bin/env bash
# What 50-agentcore plans inside its module, read from the runs of
# agentcore.tftest.hcl (see ../../../plan_checks.sh for how).
#
#   sandbox    personal-stage's profile, applied against the mock: a PUBLIC
#              runtime with web search, the browser in the VPC, no proxy
#   release    the same environment with only image_agent changed
#   firewall   a VPC runtime behind the proxy 10-network publishes, no web
#              search
#
# No credentials, no real state, no AWS calls.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../../../plan_checks.sh
source "$here/../../../plan_checks.sh"

collect_plans "$here/.."

m=module.agentcore
runtime="$m.aws_bedrockagentcore_agent_runtime.this"
browser="$m.aws_bedrockagentcore_browser.studio"
app='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"'
proxy_secret='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/browser-proxy-GhIjKl"'
subnets='["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]'
image='"111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-agent@sha256:00000000000000000000000000000000000000000000000000000000000000'
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

# --- sandbox ----------------------------------------------------------------------

check sandbox "a runtime, a browser, a credential provider, two roles and their three policies" '
  (of_type("aws_bedrockagentcore_agent_runtime") | length) == 1
  and (of_type("aws_bedrockagentcore_browser") | length) == 1
  and (of_type("aws_bedrockagentcore_api_key_credential_provider") | length) == 1
  and (of_type("aws_bedrockagentcore_agent_runtime_endpoint") | length) == 0
  and (of_type("aws_iam_role") | length) == 2 and (of_type("aws_iam_role_policy") | length) == 3'
check sandbox "the runtime is cmp_unit_agent, runs image_agent by digest, HTTP, in PUBLIC mode" "
  resource(\"$runtime\") | .agent_runtime_name == \"cmp_unit_agent\"
  and .agent_runtime_artifact[0].container_configuration[0].container_uri == ${image}c1\"
  and .protocol_configuration[0].server_protocol == \"HTTP\"
  and .network_configuration[0].network_mode == \"PUBLIC\"
  and .network_configuration[0].network_mode_config == []"
check sandbox "the runtime's environment: the CDK runtime's, the profile prefix, no proxy" "
  resource(\"$runtime\").environment_variables == {
    BEDROCK_CLIENT: \"real\", AWS_DEFAULT_REGION: \"us-east-1\", WEB_SEARCH_PROVIDER: \"brave\",
    BRAVE_SEARCH_CREDENTIAL_PROVIDER: \"cmp-unit-brave-search\", BEDROCK_INFERENCE_PROFILE_PREFIX: \"us.\"}"
check sandbox "the credential provider reads BRAVE_SEARCH_API_KEY of the app secret of 20-data" "
  resource(\"$m.aws_bedrockagentcore_api_key_credential_provider.web_search[0]\")
  | .api_key_secret_source == \"EXTERNAL\"
  and .api_key_secret_config == [{secret_id: $app, json_key: \"BRAVE_SEARCH_API_KEY\"}]"
check sandbox "the runtime role invokes exactly the models of bedrock_model_ids, and pulls from the agent repository" "
  (statement(\"$m.aws_iam_role_policy.runtime\"; \"InvokeModels\").Resource | sort) == ($models | sort)
  and statement(\"$m.aws_iam_role_policy.runtime\"; \"PullAgentImage\").Resource
    == \"arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-agent\""
check sandbox "the browser sits in the agentcore subnets with the studio_browser group, signing on" "
  resource(\"$browser\") | .name == \"cmp_unit_studio_browser\"
  and .network_configuration[0].network_mode == \"VPC\"
  and (.network_configuration[0].vpc_config[0].subnets | sort) == $subnets
  and .network_configuration[0].vpc_config[0].security_groups == [\"sg-00000000000browser\"]
  and .browser_signing == [{enabled: true}]"
check sandbox "the browser role reads the browser-proxy secret of 20-data with the secrets key, nothing else" "
  statement(\"$m.aws_iam_role_policy.browser\"; \"ReadBrowserProxyCredentials\").Resource == $proxy_secret
  and statement(\"$m.aws_iam_role_policy.browser\"; \"DecryptBrowserProxyCredentials\").Resource
    == \"arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000002\"
  and (statements(\"$m.aws_iam_role_policy.browser\") | length) == 2"
check sandbox "both roles are under /comparative/<env>/ with the workload boundary" '
  of_type("aws_iam_role") | all(
    .values.path == "/comparative/unit/"
    and .values.permissions_boundary == "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary")'
check sandbox "the stack creates no security group, rule or log group (those belong to 10-network and AgentCore)" '
  [.resources[] | select(.type | test("security_group|log_group"))] | length == 0'

# --- release ----------------------------------------------------------------------

check release "a new agent image changes the runtime and nothing else" "
  [changed[] | .address] == [\"$runtime\"]"
check release "the runtime runs the new digest" "
  resource(\"$runtime\").agent_runtime_artifact[0].container_configuration[0].container_uri == ${image}c2\""

# --- firewall ---------------------------------------------------------------------

check firewall "the runtime sits in the agentcore subnets with the agent_runtime group" "
  resource(\"$runtime\").network_configuration[0] | .network_mode == \"VPC\"
  and (.network_mode_config[0].subnets | sort) == $subnets
  and .network_mode_config[0].security_groups == [\"sg-00000000000runtime\"]"
check firewall "the runtime gets the published proxy, and no credential provider name" "
  resource(\"$runtime\").environment_variables == {
    BEDROCK_CLIENT: \"real\", AWS_DEFAULT_REGION: \"us-east-1\", WEB_SEARCH_PROVIDER: \"none\",
    BEDROCK_INFERENCE_PROFILE_PREFIX: \"us.\",
    HTTPS_PROXY: \"http://proxy.corp.example:3128\", HTTP_PROXY: \"http://proxy.corp.example:3128\",
    NO_PROXY: \"169.254.170.2,localhost,127.0.0.1\"}"
# Planned against the sandbox's state, so turning web search off deletes both.
check firewall "without web search there is no credential provider and no permission to read one" "
  [of_type(\"aws_bedrockagentcore_api_key_credential_provider\")[] | .actions] == [[\"delete\"]]
  and [of_type(\"aws_iam_role_policy\")[] | select(.actions == [\"delete\"]) | .address]
    == [\"$m.aws_iam_role_policy.runtime_web_search[0]\"]"

finish
