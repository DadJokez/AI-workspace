# GitHub Actions identities for one environment: plan, apply, image push and
# (once per account) evals. No long-lived credentials: every one of these
# roles is assumed through the account's GitHub OIDC provider. Beside them,
# the break-glass role for people, at the end of this file.
#
# Policies are written with jsonencode and ARNs are built from inputs, so every
# document is known at plan time: `terraform test` can assert on it and the
# Conftest rules can read it in the plan JSON.

data "aws_partition" "current" {}

locals {
  oidc_host = "token.actions.githubusercontent.com"
  partition = data.aws_partition.current.partition
  iam_arn   = "arn:${local.partition}:iam::${var.account_id}"

  # The provider ARN is deterministic. Building it (instead of reading it off
  # the resource) keeps the trust policies known at plan time.
  oidc_provider_arn = "${local.iam_arn}:oidc-provider/${local.oidc_host}"

  # GitHub repositories can opt into immutable (id-bound) OIDC subjects. Both
  # forms are trusted so that enabling the hardening does not lock CI out. Same
  # reasoning as infra/cdk/lib/ai-workspace-eval-ci-stack.ts.
  subject_prefixes = [
    "repo:${var.github_owner}/${var.github_repo}",
    "repo:${var.github_owner}@${var.github_owner_id}/${var.github_repo}@${var.github_repository_id}",
  ]

  # Conditions every role shares: the audience and the repository identity.
  repository_claims = {
    "${local.oidc_host}:aud"                 = "sts.amazonaws.com"
    "${local.oidc_host}:repository"          = "${var.github_owner}/${var.github_repo}"
    "${local.oidc_host}:repository_id"       = var.github_repository_id
    "${local.oidc_host}:repository_owner_id" = var.github_owner_id
  }

  # Workflow names the evals role trusts; they are the `name:` of
  # .github/workflows/nightly-evals.yml and product-smoke.yml.
  evals_main_workflow         = "Nightly Evals"
  evals_pull_request_workflow = "Product Smoke"

  state_bucket_arn = "arn:${local.partition}:s3:::${var.state_bucket_name}"
  # State objects of this environment only: <env>/<stack>.tfstate and its lock.
  state_objects_arn = "${local.state_bucket_arn}/${var.env}/*"

  workload_role_arns     = "${local.iam_arn}:role/comparative/${var.env}/*"
  workload_policy_arns   = "${local.iam_arn}:policy/comparative/${var.env}/*"
  workload_boundary_name = "${var.name_prefix}-workload-boundary"
  workload_boundary_arn  = "${local.iam_arn}:policy/${local.workload_boundary_name}"

  secret_arns    = "arn:${local.partition}:secretsmanager:${var.aws_region}:${var.account_id}:secret:comparative/${var.env}/*"
  parameter_arns = "arn:${local.partition}:ssm:${var.aws_region}:${var.account_id}:parameter/comparative/${var.env}/*"
  bucket_arns    = "arn:${local.partition}:s3:::${var.name_prefix}-*"

  bedrock_invoke_arns = [
    "arn:${local.partition}:bedrock:*::foundation-model/*",
    "arn:${local.partition}:bedrock:*:${var.account_id}:inference-profile/*",
  ]

  eval_model_arns = concat(
    var.eval_inference_profile_prefix == "" ? [] : [
      for id in var.eval_model_ids :
      "arn:${local.partition}:bedrock:${var.aws_region}:${var.account_id}:inference-profile/${var.eval_inference_profile_prefix}${id}"
    ],
    flatten([
      for region in var.eval_inference_regions : [
        for id in var.eval_model_ids :
        "arn:${local.partition}:bedrock:${region}::foundation-model/${id}"
      ]
    ]),
  )
}

# --- OIDC provider -----------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# When this environment does not own the provider, fail the plan if the account
# has none rather than create roles nobody can assume.
data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1

  url = "https://${local.oidc_host}"
}

# --- Permissions boundary for workload roles ---------------------------------

# The ceiling for every role the apply role creates (task, execution, runtime
# and service roles under /comparative/<env>/). It holds no IAM actions, so a
# workload role can never change identities, and the apply role cannot edit it.
resource "aws_iam_policy" "workload_boundary" {
  # A boundary grants nothing; it caps what a workload role's own policy can
  # grant, and that policy is where access is narrowed to named resources.
  # The statements on "*" are log delivery, the registry login, ECS Exec
  # channels, database IAM auth and the AgentCore data plane, whose resource
  # names are not known to this module.
  #checkov:skip=CKV_AWS_287:Permissions boundary, see above
  #checkov:skip=CKV_AWS_289:Permissions boundary, see above
  #checkov:skip=CKV_AWS_290:Permissions boundary, see above
  #checkov:skip=CKV_AWS_355:Permissions boundary, see above
  name = local.workload_boundary_name
  # Outside /comparative/<env>/, the only policy path the apply role can write.
  path        = "/"
  description = "Permissions boundary for Comparative workload roles in ${var.env}."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PullImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetAuthorizationToken",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = "*"
      },
      {
        Sid    = "Telemetry"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "xray:PutTelemetryRecords",
          "xray:PutTraceSegments",
        ]
        Resource = "*"
      },
      {
        Sid    = "EcsExec"
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      },
      {
        Sid      = "EnvironmentSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = local.secret_arns
      },
      {
        Sid      = "EnvironmentParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = local.parameter_arns
      },
      {
        Sid      = "EnvironmentBuckets"
        Effect   = "Allow"
        Action   = ["s3:AbortMultipartUpload", "s3:DeleteObject", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:PutObject"]
        Resource = [local.bucket_arns, "${local.bucket_arns}/*"]
      },
      {
        Sid      = "UseEnvironmentKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*"]
        Resource = var.workload_kms_key_arns
      },
      {
        Sid      = "InvokeModels"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = local.bedrock_invoke_arns
      },
      {
        Sid      = "AgentCoreDataPlane"
        Effect   = "Allow"
        Action   = "bedrock-agentcore:*"
        Resource = "*"
      },
      {
        Sid      = "DatabaseIamAuth"
        Effect   = "Allow"
        Action   = "rds-db:connect"
        Resource = "*"
      },
      {
        # Invitation email. The web task's own policy names the one identity.
        Sid      = "SendEmail"
        Effect   = "Allow"
        Action   = "ses:SendEmail"
        Resource = "arn:${local.partition}:ses:*:${var.account_id}:identity/*"
      },
    ]
  })
}

# --- tf-plan -----------------------------------------------------------------

resource "aws_iam_role" "tf_plan" {
  name                 = "${var.name_prefix}-tf-plan"
  description          = "Read-only Terraform plan role for ${var.env}; assumable from any ref of the repository."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_provider_arn }
      Condition = {
        StringEquals = local.repository_claims
        StringLike = {
          "${local.oidc_host}:sub" = [for prefix in local.subject_prefixes : "${prefix}:*"]
        }
      }
    }]
  })

  depends_on = [aws_iam_openid_connect_provider.github, data.aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy_attachment" "tf_plan_read_only" {
  role       = aws_iam_role.tf_plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "tf_plan" {
  name = "state-read-and-data-denies"
  role = aws_iam_role.tf_plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStateBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.state_bucket_arn
      },
      {
        Sid      = "ReadState"
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = local.state_objects_arn
      },
      {
        Sid      = "DecryptState"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = var.state_kms_key_arn
      },
      # This role is assumable from a pull-request ref, so ReadOnlyAccess is cut
      # back to configuration: no secret values, no object contents outside its
      # own state, no log contents.
      {
        Sid      = "DenySecretValues"
        Effect   = "Deny"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "*"
      },
      {
        Sid         = "DenyObjectContentsOutsideState"
        Effect      = "Deny"
        Action      = ["s3:GetObject", "s3:GetObjectVersion"]
        NotResource = local.state_objects_arn
      },
      {
        Sid    = "DenyLogContents"
        Effect = "Deny"
        Action = [
          "logs:FilterLogEvents",
          "logs:GetLogEvents",
          "logs:GetLogRecord",
          "logs:GetQueryResults",
          "logs:StartLiveTail",
          "logs:StartQuery",
          "logs:Unmask",
        ]
        Resource = "*"
      },
    ]
  })
}

# --- tf-apply ----------------------------------------------------------------

# Trust is the GitHub environment subject only, so the role cannot be assumed
# from a pull-request or branch ref: a job must run in the protected GitHub
# environment named after this environment.
resource "aws_iam_role" "tf_apply" {
  name                 = "${var.name_prefix}-tf-apply"
  description          = "Terraform apply role for ${var.env}; assumable only from the ${var.env} GitHub environment."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_provider_arn }
      Condition = {
        StringEquals = merge(local.repository_claims, {
          "${local.oidc_host}:sub" = [for prefix in local.subject_prefixes : "${prefix}:environment:${var.env}"]
        })
      }
    }]
  })

  depends_on = [aws_iam_openid_connect_provider.github, data.aws_iam_openid_connect_provider.github]
}

# The services stacks 10 to 60 manage. This role deliberately cannot apply
# 00-foundation: it holds no IAM permission on the CI roles, the boundary or
# the OIDC provider, and may use but not administer the KMS keys, so a merged
# change can never widen the pipeline's own access.
resource "aws_iam_role_policy" "tf_apply_services" {
  name = "managed-services"
  role = aws_iam_role.tf_apply.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          # ecs:* includes ecs:RunTask for the migrator and smoke tasks.
          Sid    = "ManagedServices"
          Effect = "Allow"
          Action = [
            "application-autoscaling:*",
            "bedrock-agentcore:*",
            "cloudwatch:*",
            "ecs:*",
            "elasticloadbalancing:*",
            "logs:*",
            "rds:*",
            "servicediscovery:*",
            "sns:*",
          ]
          Resource = "*"
        },
        {
          # Networking only: no instance, image or volume actions.
          Sid    = "Ec2Networking"
          Effect = "Allow"
          Action = [
            "ec2:*Address*",
            "ec2:*FlowLogs",
            "ec2:*Gateway*",
            "ec2:*NetworkAcl*",
            "ec2:*NetworkInterface*",
            "ec2:*PrefixList*",
            "ec2:*Route*",
            "ec2:*SecurityGroup*",
            "ec2:*Subnet*",
            "ec2:*Tags",
            "ec2:*Vpc*",
            "ec2:Describe*",
          ]
          Resource = "*"
        },
        {
          Sid    = "ReadImages"
          Effect = "Allow"
          Action = [
            "ecr:BatchGetImage",
            "ecr:Describe*",
            "ecr:GetAuthorizationToken",
            "ecr:GetLifecyclePolicy",
            "ecr:GetRepositoryPolicy",
            "ecr:ListImages",
            "ecr:ListTagsForResource",
          ]
          Resource = "*"
        },
        {
          Sid      = "EnvironmentBuckets"
          Effect   = "Allow"
          Action   = "s3:*"
          Resource = [local.bucket_arns, "${local.bucket_arns}/*"]
        },
        {
          Sid      = "DescribeParameters"
          Effect   = "Allow"
          Action   = "ssm:DescribeParameters"
          Resource = "*"
        },
        {
          Sid    = "EnvironmentParameters"
          Effect = "Allow"
          Action = [
            "ssm:AddTagsToResource",
            "ssm:DeleteParameter",
            "ssm:DeleteParameters",
            "ssm:GetParameter",
            "ssm:GetParameters",
            "ssm:GetParametersByPath",
            "ssm:LabelParameterVersion",
            "ssm:ListTagsForResource",
            "ssm:PutParameter",
            "ssm:RemoveTagsFromResource",
          ]
          Resource = local.parameter_arns
        },
        {
          Sid      = "ListSecrets"
          Effect   = "Allow"
          Action   = "secretsmanager:ListSecrets"
          Resource = "*"
        },
        {
          # Metadata only: the shell of a secret, never its value.
          Sid    = "EnvironmentSecretMetadata"
          Effect = "Allow"
          Action = [
            "secretsmanager:CreateSecret",
            "secretsmanager:DeleteResourcePolicy",
            "secretsmanager:DeleteSecret",
            "secretsmanager:DescribeSecret",
            "secretsmanager:GetResourcePolicy",
            "secretsmanager:PutResourcePolicy",
            "secretsmanager:RestoreSecret",
            "secretsmanager:TagResource",
            "secretsmanager:UntagResource",
          ]
          Resource = local.secret_arns
        },
        {
          Sid      = "DenySecretValues"
          Effect   = "Deny"
          Action   = "secretsmanager:GetSecretValue"
          Resource = "*"
        },
        {
          Sid    = "UseEnvironmentKeys"
          Effect = "Allow"
          Action = [
            "kms:CreateGrant",
            "kms:Decrypt",
            "kms:DescribeKey",
            "kms:Encrypt",
            "kms:GenerateDataKey*",
            "kms:GetKeyPolicy",
            "kms:GetKeyRotationStatus",
            "kms:ListGrants",
            "kms:ListResourceTags",
            "kms:ReEncrypt*",
            "kms:RetireGrant",
            "kms:RevokeGrant",
          ]
          Resource = var.workload_kms_key_arns
        },
        {
          # Release signatures are verified before an apply.
          Sid      = "VerifyImageSignatures"
          Effect   = "Allow"
          Action   = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Verify"]
          Resource = var.signing_key_arn
        },
      ],
      var.manage_public_edge ? [
        {
          Sid      = "PublicEdge"
          Effect   = "Allow"
          Action   = ["acm:*", "route53:*", "wafv2:*"]
          Resource = "*"
        },
      ] : [],
    )
  })
}

resource "aws_iam_role_policy" "tf_apply_iam" {
  #checkov:skip=CKV_AWS_355:The only Allow on "*" is iam:Get*/iam:List*, read-only, which Terraform needs to refresh
  name = "workload-iam"
  role = aws_iam_role.tf_apply.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadIam"
        Effect   = "Allow"
        Action   = ["iam:Get*", "iam:List*"]
        Resource = "*"
      },
      {
        # Creating a role, and every change to what it may do, requires the
        # workload boundary to be on the role.
        Sid    = "WorkloadRolesWithBoundary"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePermissionsBoundary",
          "iam:PutRolePolicy",
        ]
        Resource = local.workload_role_arns
        Condition = {
          StringEquals = { "iam:PermissionsBoundary" = local.workload_boundary_arn }
        }
      },
      {
        Sid    = "WorkloadRoleLifecycle"
        Effect = "Allow"
        Action = [
          "iam:DeleteRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = local.workload_role_arns
      },
      {
        Sid      = "PassWorkloadRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.workload_role_arns
        Condition = {
          StringEquals = {
            "iam:PassedToService" = [
              "bedrock-agentcore.amazonaws.com",
              "ecs-tasks.amazonaws.com",
              "monitoring.rds.amazonaws.com",
              "rds.amazonaws.com",
              "vpc-flow-logs.amazonaws.com",
            ]
          }
        }
      },
      {
        Sid    = "WorkloadPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = local.workload_policy_arns
      },
      {
        Sid      = "ServiceLinkedRoles"
        Effect   = "Allow"
        Action   = "iam:CreateServiceLinkedRole"
        Resource = "${local.iam_arn}:role/aws-service-role/*"
      },
      {
        Sid      = "DenyRemovingBoundary"
        Effect   = "Deny"
        Action   = "iam:DeleteRolePermissionsBoundary"
        Resource = "*"
      },
      {
        Sid    = "DenyEditingBoundary"
        Effect = "Deny"
        Action = [
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:SetDefaultPolicyVersion",
        ]
        Resource = local.workload_boundary_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "tf_apply_state" {
  name = "state-read-write"
  role = aws_iam_role.tf_apply.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListStateBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.state_bucket_arn
      },
      {
        # Covers <env>/<stack>.tfstate and the native lock file beside it.
        Sid      = "ReadWriteState"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
        Resource = local.state_objects_arn
      },
      {
        Sid      = "UseStateKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = var.state_kms_key_arn
      },
    ]
  })
}

# --- image-push --------------------------------------------------------------

resource "aws_iam_role" "image_push" {
  name                 = "${var.name_prefix}-image-push"
  description          = "Pushes and signs release images for ${var.env}; assumable only from the main branch."
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_provider_arn }
      Condition = {
        StringEquals = merge(local.repository_claims, {
          "${local.oidc_host}:sub" = [for prefix in local.subject_prefixes : "${prefix}:ref:refs/heads/main"]
        })
      }
    }]
  })

  depends_on = [aws_iam_openid_connect_provider.github, data.aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy" "image_push" {
  name = "push-and-sign"
  role = aws_iam_role.image_push.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ecr:GetAuthorizationToken does not support resource-level permissions.
        Sid      = "RegistryLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PushImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = var.ecr_repository_arns
      },
      {
        Sid      = "SignImages"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:GetPublicKey", "kms:Sign"]
        Resource = var.signing_key_arn
      },
    ]
  })
}

# --- evals -------------------------------------------------------------------

# Bedrock-invoke-only role for behavioural evals. Same trust conditions as the
# CDK role it replaces: the nightly workflow on main, and the product-smoke
# workflow on a same-repository pull-request merge ref.
resource "aws_iam_role" "evals" {
  count = var.create_evals_role ? 1 : 0

  name        = "${var.name_prefix}-evals"
  description = "Bedrock-only role for Comparative nightly and same-repository pull-request evals."
  # IAM role maxima cannot be below one hour; the workflows request less.
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = "sts:AssumeRoleWithWebIdentity"
        Principal = { Federated = local.oidc_provider_arn }
        Condition = {
          StringEquals = merge(local.repository_claims, {
            "${local.oidc_host}:sub"      = [for prefix in local.subject_prefixes : "${prefix}:ref:refs/heads/main"]
            "${local.oidc_host}:workflow" = local.evals_main_workflow
          })
          StringLike = { "${local.oidc_host}:ref" = "refs/heads/main" }
        }
      },
      {
        Effect    = "Allow"
        Action    = "sts:AssumeRoleWithWebIdentity"
        Principal = { Federated = local.oidc_provider_arn }
        Condition = {
          StringEquals = merge(local.repository_claims, {
            "${local.oidc_host}:sub"      = [for prefix in local.subject_prefixes : "${prefix}:pull_request"]
            "${local.oidc_host}:workflow" = local.evals_pull_request_workflow
          })
          StringLike = { "${local.oidc_host}:ref" = "refs/pull/*/merge" }
        }
      },
    ]
  })

  depends_on = [aws_iam_openid_connect_provider.github, data.aws_iam_openid_connect_provider.github]
}

resource "aws_iam_role_policy" "evals" {
  count = var.create_evals_role ? 1 : 0

  name = "invoke-eval-models"
  role = aws_iam_role.evals[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeEvalModelsWithResponseStream"
      Effect   = "Allow"
      Action   = "bedrock:InvokeModelWithResponseStream"
      Resource = local.eval_model_arns
    }]
  })
}

# --- break-glass -------------------------------------------------------------

# Emergency access for named people (docs/runbooks/BREAK_GLASS.md): what the
# apply role may do, by hand, when the pipeline cannot. It is not assumable
# from GitHub, needs MFA, and every assumption notifies the ops alert topic.
# What is changed with it is not in Git: the drift workflow reports it until
# it is, and the runbook gives one working day.
locals {
  break_glass_role_name = "${var.name_prefix}-break-glass"
  break_glass_role_arn  = "${local.iam_arn}:role/${local.break_glass_role_name}"
  break_glass_rule_name = "${var.name_prefix}-break-glass-assumed"
  break_glass_rule_arn  = "arn:${local.partition}:events:${var.aws_region}:${var.account_id}:rule/${local.break_glass_rule_name}"
}

resource "aws_iam_role" "break_glass" {
  name                 = local.break_glass_role_name
  description          = "Emergency access to ${var.env} for named people with MFA; every use notifies the ops alert topic. See docs/runbooks/BREAK_GLASS.md."
  max_session_duration = 3600

  # MFA in this session, at most an hour old. A role named here can assume
  # the role only from a session that carries MFA, which a chained role
  # session does not: in practice the principals are IAM users with MFA.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "NamedPeopleWithMfa"
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = var.break_glass_principal_arns }
      Condition = {
        Bool            = { "aws:MultiFactorAuthPresent" = "true" }
        NumericLessThan = { "aws:MultiFactorAuthAge" = "3600" }
      }
    }]
  })
}

# Read everything, to find what is wrong; CloudTrail's history among it.
resource "aws_iam_role_policy_attachment" "break_glass_read_only" {
  role       = aws_iam_role.break_glass.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

# Change what the apply role may change, with the same documents: the
# resources of stacks 10 to 60 and their state, never a secret value, never
# IAM outside /comparative/<env>/, never 00-foundation. Wider access is the
# account administrator's, as for 00-foundation itself.
resource "aws_iam_role_policy" "break_glass" {
  #checkov:skip=CKV_AWS_355:The apply role's documents (tf_apply_iam carries the same skip): the only Allow on "*" in workload-iam is iam:Get*/iam:List*, read-only
  for_each = {
    "managed-services" = aws_iam_role_policy.tf_apply_services.policy
    "workload-iam"     = aws_iam_role_policy.tf_apply_iam.policy
    "state-read-write" = aws_iam_role_policy.tf_apply_state.policy
  }

  name   = each.key
  role   = aws_iam_role.break_glass.id
  policy = each.value
}

# Whoever holds the role cannot silence the notice of its use.
resource "aws_iam_role_policy" "break_glass_keep_the_notice" {
  name = "keep-the-notice"
  role = aws_iam_role.break_glass.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyChangingTheOpsTopic"
        Effect   = "Deny"
        Action   = ["sns:AddPermission", "sns:DeleteTopic", "sns:RemovePermission", "sns:SetTopicAttributes"]
        Resource = var.ops_topic_arn
      },
      {
        Sid      = "DenyChangingTheRule"
        Effect   = "Deny"
        Action   = ["events:DeleteRule", "events:DisableRule", "events:PutRule", "events:PutTargets", "events:RemoveTargets"]
        Resource = local.break_glass_rule_arn
      },
    ]
  })
}

# Every assumption of the role, from the command line (AssumeRole) or the
# console (SwitchRole), notifies the ops alert topic. CloudTrail may record
# AssumeRole as a read-only event, which EventBridge delivers only to a rule
# in this state. A rule sees the events of its own region: the role is
# assumed through the STS endpoint of aws_region (the global endpoint logs in
# us-east-1). The SwitchRole pattern was not checked against a recorded event.
resource "aws_cloudwatch_event_rule" "break_glass_assumed" {
  name        = local.break_glass_rule_name
  description = "Every assumption of ${local.break_glass_role_name}; notifies the ops alert topic."
  state       = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"

  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail", "AWS Console Sign In via CloudTrail"]
    detail = {
      "$or" = [
        {
          eventSource       = ["sts.amazonaws.com"]
          eventName         = ["AssumeRole"]
          requestParameters = { roleArn = [local.break_glass_role_arn] }
        },
        {
          eventSource = ["signin.amazonaws.com"]
          eventName   = ["SwitchRole"]
          userIdentity = {
            arn = [{ prefix = "arn:${local.partition}:sts::${var.account_id}:assumed-role/${local.break_glass_role_name}/" }]
          }
        },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "break_glass_assumed" {
  rule      = aws_cloudwatch_event_rule.break_glass_assumed.name
  target_id = "ops-alerts"
  arn       = var.ops_topic_arn

  input_transformer {
    input_paths = {
      who    = "$.detail.userIdentity.arn"
      event  = "$.detail.eventName"
      at     = "$.time"
      source = "$.detail.sourceIPAddress"
    }
    input_template = "\"Break-glass: <who> used ${local.break_glass_role_name} (<event>) at <at> from <source>. Every change made with it must be in Git within one working day: docs/runbooks/BREAK_GLASS.md.\""
  }
}
