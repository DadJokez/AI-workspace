# Salesforce Gateway + Harness Spike Runbook

Status: ready to run manually
Owner: Rob / Comparative engineering
Related issue: #279

This runbook proves the AgentCore Gateway + Harness path end to end against a
free Salesforce Developer Edition org. It is intentionally a learning spike,
not production infrastructure.

Goal: ask an AgentCore-managed agent, "How many accounts are in Salesforce? List
5 by name," and see it call a Gateway tool that runs read-only SOQL against the
dev org, with traces.

## Guardrails

- Do not commit Salesforce client secrets, access tokens, instance URLs tied to a
  real customer org, or generated `.env` files.
- Use a Salesforce Developer Edition org with sample data, not a GP or customer
  tenant.
- Keep the first OpenAPI target read-only. Only expose `SELECT` SOQL and object
  describe endpoints for this spike.
- Use `us-east-1` unless AgentCore availability or the AWS account policy says
  otherwise.
- Treat the CLI wizard as the source of truth if generated command shapes differ
  from this document. AgentCore changed quickly around Harness GA.

## Prerequisites

- AWS CLI configured in the target account.
- Bedrock model access enabled for one Claude model in the target region.
- Node.js 20+ and Python 3.10+.
- AgentCore CLI installed:

```bash
npm install -g @aws/agentcore
```

References:
- [AgentCore CLI quickstart](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-get-started-cli.html)
- [AgentCore Gateway quickstart](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-quick-start.html)
- [AgentCore Harness get started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html)
- [InvokeHarness API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeHarness.html)
- [Salesforce client credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.connected_app_client_credentials_setup.htm&language=en_US&type=5)

## Phase 1: Salesforce Developer Edition

1. Sign up for a free Developer Edition org at
   `https://developer.salesforce.com/signup`.
2. Verify email, set the password, and note the instance URL.
3. In Salesforce Setup, create a Connected App or External Client App.
4. Enable OAuth and include these scopes:
   - `api`
   - `refresh_token offline_access`
   - `id`
5. Enable the client credentials flow and assign a run-as user. Salesforce
   requires an execution user even for server-to-server auth.
6. Copy the Consumer Key and Consumer Secret.
7. Sanity-check outside AWS:

```bash
export SF_KEY="replace-me"
export SF_SECRET="replace-me"

TOKEN_JSON="$(curl -s https://login.salesforce.com/services/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id="$SF_KEY" \
  -d client_secret="$SF_SECRET")"

export SF_TOKEN="$(printf '%s' "$TOKEN_JSON" | jq -r .access_token)"
export SF_INSTANCE="$(printf '%s' "$TOKEN_JSON" | jq -r .instance_url)"

curl -s "$SF_INSTANCE/services/data/v61.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+5" \
  -H "Authorization: Bearer $SF_TOKEN" | jq .
```

Pass condition: Salesforce returns Account records or an empty but valid query
response. Auth or permission errors must be fixed before touching AgentCore.

## Phase 2: Gateway + Salesforce Target

Create a disposable agent and gateway:

```bash
agentcore create --name SfdcAgent
agentcore add gateway --name SfdcGateway \
  --authorizer-type NONE \
  --runtimes SfdcAgent
```

Add a Gateway HTTP/OpenAPI target through the interactive CLI:

```bash
agentcore
```

Use the TUI path for Gateway target creation because credential-provider flags
can move faster than the docs. Choose HTTP/OpenAPI target, provide
`salesforce-soql.openapi.yaml` from this runbook, and configure OAuth2
client-credentials using:

- client id: Salesforce Consumer Key
- client secret: Salesforce Consumer Secret
- token URL: `https://login.salesforce.com/services/oauth2/token`
- scopes: empty or the scopes configured above, depending on the wizard prompt

Deploy and confirm tool exposure:

```bash
agentcore deploy
agentcore status
```

If the gateway prints an MCP URL, sanity-check tool listing:

```bash
curl -s -X POST "$GATEWAY_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

Pass condition: `runSoqlQuery` and `describeSObject` are listed.

## Artifact A: Minimal Salesforce SOQL OpenAPI Spec

Save this as `salesforce-soql.openapi.yaml` outside the repo or in a local
scratch directory. Replace `YOUR_INSTANCE`.

```yaml
openapi: 3.0.3
info:
  title: Salesforce REST minimal SOQL
  version: "1.0.0"
  description: Read-only Salesforce REST surface for an AgentCore Gateway HTTP target.
servers:
  - url: https://YOUR_INSTANCE.my.salesforce.com
security:
  - salesforceOAuth: []
paths:
  /services/data/v61.0/query:
    get:
      operationId: runSoqlQuery
      summary: Run a read-only SOQL query
      description: >
        Execute a SOQL SELECT query against Salesforce. Only SELECT statements
        are allowed for this spike.
      parameters:
        - name: q
          in: query
          required: true
          description: Complete SOQL SELECT statement.
          schema:
            type: string
      responses:
        "200":
          description: Query results
          content:
            application/json:
              schema:
                type: object
                additionalProperties: true
  /services/data/v61.0/sobjects/{sobject}/describe:
    get:
      operationId: describeSObject
      summary: Describe Salesforce object fields
      description: Return field metadata for Account, Opportunity, Contact, or another SObject.
      parameters:
        - name: sobject
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: SObject metadata
          content:
            application/json:
              schema:
                type: object
                additionalProperties: true
components:
  securitySchemes:
    salesforceOAuth:
      type: oauth2
      description: OAuth2 client credentials brokered by AgentCore Gateway.
      flows:
        clientCredentials:
          tokenUrl: https://login.salesforce.com/services/oauth2/token
          scopes: {}
```

## Phase 3: Harness Test

Fastest path:

```bash
agentcore dev
```

In the inspector, ask:

```text
How many accounts are in Salesforce? List 5 by name.
```

Scripted path:

```bash
agentcore invoke --harness SfdcAgent --session-id "$(uuidgen)" \
  "List 5 Salesforce accounts and the count of open opportunities."
```

SDK path if needed:

```python
import boto3
import uuid

client = boto3.client("bedrock-agentcore", region_name="us-east-1")
response = client.invoke_harness(
    harnessArn="<HARNESS_ARN>",
    runtimeSessionId=str(uuid.uuid4()),
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "text": "How many accounts are in Salesforce? List 5 by name."
                }
            ],
        }
    ],
)

for event in response["stream"]:
    delta = event.get("contentBlockDelta", {}).get("delta", {})
    if "text" in delta:
        print(delta["text"], end="", flush=True)
```

Pass condition: the answer cites the Salesforce object/fields queried and
matches the dev org's Account data.

## Phase 4: Observe And Clean Up

Watch gateway/harness logs from the AWS console or CLI. Log group names can vary
by CLI version; use `agentcore status` and the AgentCore console to locate the
gateway and harness IDs first.

Clean up all disposable resources:

```bash
agentcore remove gateway --name SfdcGateway
agentcore remove all
```

Then revoke or rotate the Salesforce connected app secret.

## Completion Checklist

- [ ] Salesforce client credentials query works outside AWS.
- [ ] Gateway target lists `runSoqlQuery` and `describeSObject`.
- [ ] Harness invokes Gateway and returns real Account data.
- [ ] Logs/traces show tool calls and timing.
- [ ] Costs checked in AWS Billing/Cost Explorer.
- [ ] Gateway, harness, temporary credentials, and dev artifacts cleaned up.

## Follow-Ups If The Spike Passes

- Move the OpenAPI spec into IaC or a reviewed config package.
- Replace `--authorizer-type NONE` with the approved inbound authorizer.
- Add scoped IAM for the harness execution role.
- Add evals for "count/list accounts" and "describe fields before querying".
- Decide whether Salesforce belongs in the Comparative shell connector catalog,
  AgentCore Gateway only, or both.
