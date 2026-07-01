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
- [Salesforce external client app credentials flow](https://help.salesforce.com/s/articleView?id=xcloud.configure_client_credentials_flow_for_external_client_apps.htm&language=en_US&type=5)

## Phase 1: Salesforce Developer Edition

1. Sign up for a free Developer Edition org at
   `https://developer.salesforce.com/signup`.
2. Verify email, set the password, and note the org URL.
   - Lightning UI URLs often look like
     `https://ORG.develop.lightning.force.com/lightning/...`.
   - API server URLs usually use the matching
     `https://ORG.develop.my.salesforce.com` host.
3. In Salesforce Setup, create an External Client App. In older orgs this can
   appear as a Connected App.
4. Enable OAuth.
5. If Salesforce requires a callback URL, use the Comparative callback placeholder:

   ```text
   https://comparative.builtwithrobot.link/api/integrations/salesforce/callback
   ```

   This callback is not used by the client credentials flow, but Salesforce
   still requires a syntactically valid URL when OAuth is enabled.
6. Add only the required OAuth scope for the spike:
   - `Manage user data via APIs (api)`

   Optional:
   - `Access the identity URL service (id, profile, email, address, phone)`

   Do not add `full`, `web`, or `refresh_token offline_access` for this
   server-to-server spike. Refresh tokens are for delegated user flows, not the
   client credentials path used here.
7. Enable only the client credentials flow. Leave SAML, Canvas, Mobile, Push,
   Authorization Code, Device, JWT Bearer, and Token Exchange flows disabled.
8. In OAuth Policies, set:
   - Permitted Users: `All users can self-authorize` is acceptable for the dev
     spike. If Salesforce rejects the execution user, switch to
     `Admin approved users are pre-authorized` and assign the user/profile.
   - Enable Client Credentials Flow: checked.
   - Run As Username: the exact Salesforce username from Setup -> Users, not
     necessarily the email address used to sign up. Developer Edition usernames
     can look generated, for example `rob.fea863df9cc1@agentforce.com`.
   - IP Relaxation: `Relax IP restrictions` for the spike, because AgentCore
     will call Salesforce from AWS infrastructure, not Rob's browser IP.
9. Save the app. If Salesforce reports "Enter a valid execution user," verify
   that the Run As user is active, API-enabled, and copied exactly from the
   Salesforce Username column.
10. Copy the Consumer Key and Consumer Secret from Consumer Details or OAuth
    Credentials. Do not paste the secret into chat, GitHub, or committed files.
11. Sanity-check outside AWS with a zsh/bash-safe prompt flow:

```bash
printf "Salesforce Consumer Key / Client ID: "
IFS= read -r SF_CLIENT_ID

printf "Salesforce Consumer Secret / Client Secret: "
stty -echo
IFS= read -r SF_CLIENT_SECRET
stty echo
printf "\n"

TOKEN_JSON="$(curl -s https://login.salesforce.com/services/oauth2/token \
  -d grant_type=client_credentials \
  --data-urlencode "client_id=$SF_CLIENT_ID" \
  --data-urlencode "client_secret=$SF_CLIENT_SECRET")"

printf '%s' "$TOKEN_JSON" | jq '{
  token_received: (.access_token != null),
  instance_url,
  token_type,
  error,
  error_description
}'
```

Pass condition: `token_received` is `true`. Do not print the raw access token.

Then query the dev org:

```bash
export SF_TOKEN="$(printf '%s' "$TOKEN_JSON" | jq -r .access_token)"
export SF_INSTANCE="$(printf '%s' "$TOKEN_JSON" | jq -r .instance_url)"

curl -s "$SF_INSTANCE/services/data/v61.0/query/?q=SELECT+Id,Name+FROM+Account+LIMIT+5" \
  -H "Authorization: Bearer $SF_TOKEN" | jq .
```

Pass condition: Salesforce returns Account records or an empty but valid query
response. Auth or permission errors must be fixed before touching AgentCore.
Common errors:

- `invalid_client_id`: the key prompt was blank or the wrong Consumer Key was
  copied.
- `invalid_client`: the Consumer Secret is wrong.
- `invalid_grant` or `no client credentials user enabled`: the Run As user is
  missing, invalid, inactive, or not authorized for the app.
- API/object permission errors: the Run As user lacks API access or read access
  to the queried object.

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
- scopes: empty or `api`, depending on the wizard prompt

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
