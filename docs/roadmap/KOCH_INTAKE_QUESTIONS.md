# Koch platform intake questions

The questions Rob takes to the Koch platform team (issue #971). Each answer becomes a row in
[ADR 0015](../adr/0015-koch-landing-zone-contract.md), which maps it to the Terraform or application
variable it sets. Until an answer arrives, the build uses the default recorded there.

Context for whoever answers: Comparative is a containerised web application with three background
services. It needs a container runtime, PostgreSQL, Amazon Bedrock, an OIDC identity provider, and an
outbound allowlist. Plan: [`KOCH_FIREWALL_PLAN.md`](KOCH_FIREWALL_PLAN.md).

## 1. Accounts and regions

1. Will Koch vend one AWS account per environment (dev, stage, prod), and how is that requested?
2. Which regions are approved? We build for `us-east-1` today.
3. Which shared accounts exist (network, logging, security) and what must we integrate with?
4. Is there a permissions boundary or service control policy that limits the IAM roles we may create?

## 2. Network

1. Who owns the VPC and subnets: does the landing zone supply them, or do we create them?
2. Which subnets may hold application tasks and which the database? How many availability zones?
3. What DNS zone and name will the application get, and who issues the TLS certificate?
4. Which VPC interface endpoints are allowed or already shared? We need Bedrock runtime, Bedrock
   AgentCore, Secrets Manager, KMS, CloudWatch Logs and metrics, ECR, STS, SSM and ECS.
5. What is the outbound proxy address, does it require authentication, and does it inspect TLS? If it
   does, how is the corporate certificate authority supplied to containers?
6. What is the process and lead time to add a host to the proxy allowlist?
7. Is any inbound path from outside the corporate network possible (for webhooks)? We assume none.
8. Which corporate address ranges should the internal load balancer accept?

## 3. GitHub Enterprise

1. Is it GitHub Enterprise Cloud or Server, and what is the host name?
2. Which organisation will hold the repository, and what naming and visibility rules apply?
3. Are GitHub-hosted runners allowed, or must builds use runners inside the network? What labels?
4. Is OIDC federation from GitHub Actions to AWS allowed, and what is the issuer URL?
5. Which checks, branch protections and review rules are mandatory?
6. Does GitHub Enterprise expose an MCP endpoint for the GitHub connector, and at what URL?
7. Can GitHub reach an internal webhook URL, or must the application poll for events?

## 4. Terraform

1. Terraform Enterprise, or state in S3 in our own account?
2. Are there mandatory modules or a private module registry?
3. Which policy sets (Sentinel or OPA) run on plans, and can we see them in advance?
4. What is the tagging standard (required keys and allowed values)?

## 5. Container images

1. Which registry must images live in: ECR in our account, or a central registry?
2. Are there approved base images, or rules for choosing one? Is there a mirror of public registries?
3. Which image scanner is required, and what severity blocks a release?
4. Is image signing required, and with what tooling?

## 6. Identity

1. Which Ping tenant and environment do we register in, and how is an OIDC application requested?
2. What is the group claim called, and does it carry names or identifiers?
3. Which groups should grant access and which should grant the administrator role?
4. Is SCIM provisioning available for joiner and leaver events?
5. What session lifetime and re-authentication policy applies?
6. Is a test tenant available before production registration?

## 7. Logging and security monitoring

1. Where must application and audit logs be delivered, and in what format?
2. What retention is required for application logs and for the audit trail?
3. Are VPC flow logs, CloudTrail and GuardDuty handled centrally?

## 8. Encryption keys

1. Must data be encrypted with customer-managed KMS keys, and who administers the key policy?
2. Is there a required rotation period?

## 9. Bedrock

1. What is the model-access process in a Koch account, and which models are already approved?
2. Are cross-region inference profiles (`us.` prefix) allowed, or must inference stay in one region?
3. Must we use the existing Koch chat tool's gateway or quota, or do we get our own?
4. Are Bedrock Guardrails required, and is there a standard configuration?

## 10. Data

1. Which data classifications are allowed for a ten-person pilot?
2. Are there residency or retention rules beyond the logging answers above?

## 11. Change management and review

1. Which security and architecture reviews must pass before the first user, and in what order?
2. Is a penetration test required, and who runs it?
3. What change-management process applies to production deployments?
4. Who is the platform contact for incidents?

## 12. Cost

1. How are account costs allocated (cost centre, tags)?
2. Is there a budget approval step before the accounts are created?
