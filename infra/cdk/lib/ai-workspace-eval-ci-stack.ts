import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const GITHUB_REPOSITORY = "DadJokez/AI-workspace";
const GITHUB_REPOSITORY_ID = "1224105845";
const GITHUB_REPOSITORY_OWNER_ID = "23159363";

const CLASSIC_MAIN_SUBJECT =
  "repo:DadJokez/AI-workspace:ref:refs/heads/main";
const CLASSIC_PULL_REQUEST_SUBJECT =
  "repo:DadJokez/AI-workspace:pull_request";

// GitHub repositories can opt into immutable OIDC subjects. Trust both the
// repository's current classic subject and its ID-bound equivalent so that
// enabling that hardening later does not silently stop the eval gate.
const IMMUTABLE_MAIN_SUBJECT =
  "repo:DadJokez@23159363/AI-workspace@1224105845:ref:refs/heads/main";
const IMMUTABLE_PULL_REQUEST_SUBJECT =
  "repo:DadJokez@23159363/AI-workspace@1224105845:pull_request";

const EVAL_INFERENCE_PROFILES = [
  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "us.anthropic.claude-sonnet-4-6",
] as const;

const EVAL_FOUNDATION_MODELS = [
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-sonnet-4-6",
] as const;

const US_INFERENCE_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
] as const;

/**
 * Isolated GitHub Actions identity for behavioral evals.
 *
 * This stack deliberately has no access to the production application,
 * databases, secrets, provider credentials, or deployment roles. Its only
 * AWS permission is streamed invocation of the two Bedrock models used by
 * the eval harness.
 */
export class AiWorkspaceEvalCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use the L1 directly so CloudFormation owns the provider without CDK's
    // thumbprint-discovery Lambda or its account-wide provider CRUD policy.
    // IAM retrieves the current intermediate CA thumbprint when omitted.
    const githubOidcProvider = new iam.CfnOIDCProvider(
      this,
      "GitHubActionsOidcProvider",
      {
        url: `https://${GITHUB_OIDC_HOST}`,
        clientIdList: ["sts.amazonaws.com"],
        tags: [
          { key: "Application", value: "Comparative" },
          { key: "Purpose", value: "EvalCI" },
        ],
      },
    );

    const evalRole = new iam.Role(this, "GitHubEvalRole", {
      roleName: "ComparativeGitHubEvalsRole",
      description:
        "Bedrock-only role for Comparative nightly and same-repository pull-request evals.",
      assumedBy: githubPrincipal(githubOidcProvider.attrArn, {
        subjects: [CLASSIC_MAIN_SUBJECT, IMMUTABLE_MAIN_SUBJECT],
        workflow: "Nightly Evals",
        ref: "refs/heads/main",
      }),
      // IAM role maxima cannot be below one hour. The workflows request much
      // shorter 30-minute PR and 60-minute nightly sessions from this ceiling.
      maxSessionDuration: cdk.Duration.hours(1),
    });

    evalRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRoleWithWebIdentity"],
        principals: [
          githubPrincipal(githubOidcProvider.attrArn, {
            subjects: [
              CLASSIC_PULL_REQUEST_SUBJECT,
              IMMUTABLE_PULL_REQUEST_SUBJECT,
            ],
            workflow: "Product Smoke",
            ref: "refs/pull/*/merge",
          }),
        ],
      }),
    );

    evalRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeEvalModelsWithResponseStream",
        actions: ["bedrock:InvokeModelWithResponseStream"],
        resources: [
          ...EVAL_INFERENCE_PROFILES.map(
            (profileId) =>
              `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/${profileId}`,
          ),
          ...US_INFERENCE_REGIONS.flatMap((region) =>
            EVAL_FOUNDATION_MODELS.map(
              (modelId) =>
                `arn:${this.partition}:bedrock:${region}::foundation-model/${modelId}`,
            ),
          ),
        ],
      }),
    );

    cdk.Tags.of(evalRole).add("Application", "Comparative");
    cdk.Tags.of(evalRole).add("Purpose", "EvalCI");

    new cdk.CfnOutput(this, "AwsEvalRoleArn", {
      value: evalRole.roleArn,
      description:
        "Set this ARN as the GitHub Actions repository variable AWS_EVAL_ROLE_ARN.",
      exportName: "ComparativeAwsEvalRoleArn",
    });

    new cdk.CfnOutput(this, "GitHubOidcProviderArn", {
      value: githubOidcProvider.attrArn,
      description: "GitHub Actions OIDC provider created for the eval role.",
    });
  }
}

function githubPrincipal(
  providerArn: string,
  input: {
    subjects: string[];
    workflow: string;
    ref: string;
  },
): iam.FederatedPrincipal {
  return new iam.FederatedPrincipal(
    providerArn,
    {
      StringEquals: {
        [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
        [`${GITHUB_OIDC_HOST}:repository`]: GITHUB_REPOSITORY,
        [`${GITHUB_OIDC_HOST}:repository_id`]: GITHUB_REPOSITORY_ID,
        [`${GITHUB_OIDC_HOST}:repository_owner_id`]:
          GITHUB_REPOSITORY_OWNER_ID,
        [`${GITHUB_OIDC_HOST}:sub`]: input.subjects,
        [`${GITHUB_OIDC_HOST}:workflow`]: input.workflow,
      },
      StringLike: {
        [`${GITHUB_OIDC_HOST}:ref`]: input.ref,
      },
    },
    "sts:AssumeRoleWithWebIdentity",
  );
}
