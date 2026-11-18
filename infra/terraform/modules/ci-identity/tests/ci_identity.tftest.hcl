# Plan-only tests with a mocked provider: no credentials, no AWS calls.

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }
}

variables {
  env         = "unit"
  name_prefix = "cmp-unit"
  aws_region  = "us-east-1"
  account_id  = "111122223333"

  create_oidc_provider = false
  create_evals_role    = true
  manage_public_edge   = false

  github_owner         = "example-owner"
  github_repo          = "example-repo"
  github_owner_id      = "1001"
  github_repository_id = "2002"

  state_bucket_name = "comparative-tfstate-111122223333-us-east-1"
  state_kms_key_arn = "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000"

  ecr_repository_arns = [
    "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-app",
    "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-agent",
  ]
  signing_key_arn       = "arn:aws:kms:us-east-1:111122223333:key/11111111-1111-1111-1111-111111111111"
  workload_kms_key_arns = ["arn:aws:kms:us-east-1:111122223333:key/22222222-2222-2222-2222-222222222222"]

  eval_model_ids                = ["example.model-a-v1:0", "example.model-b"]
  eval_inference_profile_prefix = "us."
  eval_inference_regions        = ["us-east-1", "us-west-2"]
}

run "names_follow_the_prefix" {
  command = plan

  assert {
    condition     = aws_iam_role.tf_plan.name == "cmp-unit-tf-plan"
    error_message = "plan role name"
  }
  assert {
    condition     = aws_iam_role.tf_apply.name == "cmp-unit-tf-apply"
    error_message = "apply role name"
  }
  assert {
    condition     = aws_iam_role.image_push.name == "cmp-unit-image-push"
    error_message = "image-push role name"
  }
  assert {
    condition     = aws_iam_role.evals[0].name == "cmp-unit-evals"
    error_message = "evals role name"
  }
}

run "oidc_provider_is_looked_up_by_default" {
  command = plan

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "the provider must not be created when create_oidc_provider is false"
  }
  assert {
    condition     = length(data.aws_iam_openid_connect_provider.github) == 1
    error_message = "the existing provider must be looked up"
  }
}

run "oidc_provider_is_created_on_request" {
  command = plan

  variables {
    create_oidc_provider = true
  }

  assert {
    condition     = aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com"
    error_message = "provider url"
  }
  assert {
    condition     = aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"])
    error_message = "provider audience"
  }
  assert {
    condition     = length(data.aws_iam_openid_connect_provider.github) == 0
    error_message = "no lookup when the provider is created here"
  }
}

run "every_trust_policy_pins_audience_and_repository" {
  command = plan

  assert {
    condition = alltrue([
      for policy in [
        aws_iam_role.tf_plan.assume_role_policy,
        aws_iam_role.tf_apply.assume_role_policy,
        aws_iam_role.image_push.assume_role_policy,
        aws_iam_role.evals[0].assume_role_policy,
        ] : alltrue([
          for statement in jsondecode(policy).Statement :
          statement.Action == "sts:AssumeRoleWithWebIdentity"
          && statement.Principal.Federated == "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
          && statement.Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
          && statement.Condition.StringEquals["token.actions.githubusercontent.com:repository"] == "example-owner/example-repo"
          && statement.Condition.StringEquals["token.actions.githubusercontent.com:repository_id"] == "2002"
          && statement.Condition.StringEquals["token.actions.githubusercontent.com:repository_owner_id"] == "1001"
      ])
    ])
    error_message = "every trust statement must pin the provider, audience, repository and both numeric ids"
  }
}

run "plan_role_trusts_any_ref_of_the_repository" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.tf_plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] == [
      "repo:example-owner/example-repo:*",
      "repo:example-owner@1001/example-repo@2002:*",
    ]
    error_message = "plan role subject"
  }
}

run "apply_role_trusts_only_the_github_environment" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == [
      "repo:example-owner/example-repo:environment:unit",
      "repo:example-owner@1001/example-repo@2002:environment:unit",
    ]
    error_message = "apply role subject must be the environment subject, exactly"
  }
  assert {
    condition     = length(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement) == 1
    error_message = "apply role must have a single trust statement"
  }
  assert {
    condition     = keys(jsondecode(aws_iam_role.tf_apply.assume_role_policy).Statement[0].Condition) == ["StringEquals"]
    error_message = "apply role trust must not use a pattern match"
  }
}

run "image_push_role_trusts_only_main" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.image_push.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == [
      "repo:example-owner/example-repo:ref:refs/heads/main",
      "repo:example-owner@1001/example-repo@2002:ref:refs/heads/main",
    ]
    error_message = "image-push role subject"
  }
  assert {
    condition     = keys(jsondecode(aws_iam_role.image_push.assume_role_policy).Statement[0].Condition) == ["StringEquals"]
    error_message = "image-push role trust must not use a pattern match"
  }
}

run "evals_role_matches_the_cdk_trust" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement) == 2
    error_message = "evals role has a nightly and a pull-request statement"
  }
  assert {
    condition = (
      jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:workflow"] == "Nightly Evals"
      && jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:ref"] == "refs/heads/main"
      && jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == [
        "repo:example-owner/example-repo:ref:refs/heads/main",
        "repo:example-owner@1001/example-repo@2002:ref:refs/heads/main",
      ]
    )
    error_message = "nightly statement"
  }
  assert {
    condition = (
      jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[1].Condition.StringEquals["token.actions.githubusercontent.com:workflow"] == "Product Smoke"
      && jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[1].Condition.StringLike["token.actions.githubusercontent.com:ref"] == "refs/pull/*/merge"
      && jsondecode(aws_iam_role.evals[0].assume_role_policy).Statement[1].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == [
        "repo:example-owner/example-repo:pull_request",
        "repo:example-owner@1001/example-repo@2002:pull_request",
      ]
    )
    error_message = "pull-request statement"
  }
  assert {
    condition     = aws_iam_role.evals[0].max_session_duration == 3600
    error_message = "evals session ceiling"
  }
}

run "evals_role_may_only_stream_the_listed_models" {
  command = plan

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.evals[0].policy).Statement) == 1
    error_message = "evals policy has one statement"
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.evals[0].policy).Statement[0].Action == "bedrock:InvokeModelWithResponseStream"
    error_message = "evals policy action"
  }
  assert {
    condition = jsondecode(aws_iam_role_policy.evals[0].policy).Statement[0].Resource == [
      "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.example.model-a-v1:0",
      "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.example.model-b",
      "arn:aws:bedrock:us-east-1::foundation-model/example.model-a-v1:0",
      "arn:aws:bedrock:us-east-1::foundation-model/example.model-b",
      "arn:aws:bedrock:us-west-2::foundation-model/example.model-a-v1:0",
      "arn:aws:bedrock:us-west-2::foundation-model/example.model-b",
    ]
    error_message = "evals policy resources"
  }
}

run "evals_role_is_optional" {
  command = plan

  variables {
    create_evals_role = false
  }

  assert {
    condition     = length(aws_iam_role.evals) == 0 && length(aws_iam_role_policy.evals) == 0
    error_message = "no evals role when create_evals_role is false"
  }
  assert {
    condition     = output.evals_role_arn == null
    error_message = "evals_role_arn output must be null"
  }
}

run "plan_role_is_read_only_without_secret_values" {
  command = plan

  assert {
    condition     = aws_iam_role_policy_attachment.tf_plan_read_only.policy_arn == "arn:aws:iam::aws:policy/ReadOnlyAccess"
    error_message = "plan role attaches ReadOnlyAccess"
  }
  assert {
    condition = contains(
      [for s in jsondecode(aws_iam_role_policy.tf_plan.policy).Statement : s.Action if s.Effect == "Deny" && try(s.Resource, "") == "*"],
      "secretsmanager:GetSecretValue",
    )
    error_message = "plan role must deny secretsmanager:GetSecretValue on every resource"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tf_plan.policy).Statement :
      contains(["s3:ListBucket", "s3:GetObject", "kms:Decrypt"], s.Action) if s.Effect == "Allow"
    ])
    error_message = "plan role's own grants are state read and state decrypt only"
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.tf_plan.policy).Statement : s.Resource if s.Sid == "ReadState"
    ]) == "arn:aws:s3:::comparative-tfstate-111122223333-us-east-1/unit/*"
    error_message = "plan role reads only this environment's state objects"
  }
}

run "apply_role_iam_is_fenced_to_the_environment_path_and_boundary" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tf_apply_iam.policy).Statement :
      s.Resource == "arn:aws:iam::111122223333:role/comparative/unit/*"
      && s.Condition.StringEquals["iam:PermissionsBoundary"] == "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary"
      if s.Effect == "Allow" && (contains(flatten([s.Action]), "iam:CreateRole") || contains(flatten([s.Action]), "iam:PutRolePolicy") || contains(flatten([s.Action]), "iam:AttachRolePolicy"))
    ])
    error_message = "creating or granting to a role requires the environment path and the boundary"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tf_apply_iam.policy).Statement :
      s.Sid == "ReadIam" || startswith(s.Resource, "arn:aws:iam::111122223333:role/comparative/unit/") || startswith(s.Resource, "arn:aws:iam::111122223333:policy/comparative/unit/") || s.Resource == "arn:aws:iam::111122223333:role/aws-service-role/*"
      if s.Effect == "Allow"
    ])
    error_message = "apply role IAM writes must stay under /comparative/<env>/"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tf_apply_iam.policy).Statement :
      alltrue([for action in flatten([s.Action]) : startswith(action, "iam:Get") || startswith(action, "iam:List")])
      if s.Sid == "ReadIam"
    ])
    error_message = "the only IAM grant on every resource is read"
  }
  assert {
    condition     = aws_iam_policy.workload_boundary.name == "cmp-unit-workload-boundary" && aws_iam_policy.workload_boundary.path == "/"
    error_message = "the boundary must live outside the path the apply role can write"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement :
      alltrue([for action in flatten([s.Action]) : !startswith(action, "iam:") && !startswith(action, "sts:") && action != "*"])
    ])
    error_message = "the boundary must not allow IAM or STS actions"
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_policy.workload_boundary.policy).Statement : s
      if length([for action in flatten([s.Action]) : action if startswith(action, "ses:")]) > 0
      ]) == {
      Sid      = "SendEmail"
      Effect   = "Allow"
      Action   = "ses:SendEmail"
      Resource = "arn:aws:ses:*:111122223333:identity/*"
    }
    error_message = "the boundary allows sending email from this account's identities, and no other SES action"
  }
}

run "apply_role_cannot_read_secret_values" {
  command = plan

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.tf_apply_services.policy).Statement :
      alltrue([
        for action in flatten([s.Action]) :
        !contains(["secretsmanager:*", "secretsmanager:GetSecretValue", "secretsmanager:Get*", "secretsmanager:BatchGetSecretValue", "*"], action)
      ])
      if s.Effect == "Allow"
    ])
    error_message = "apply role must not be allowed to read secret values"
  }
  assert {
    condition = contains(
      [for s in jsondecode(aws_iam_role_policy.tf_apply_services.policy).Statement : s.Action if s.Effect == "Deny" && s.Resource == "*"],
      "secretsmanager:GetSecretValue",
    )
    error_message = "apply role must deny secretsmanager:GetSecretValue"
  }
}

run "apply_role_has_no_bedrock_wildcard_and_edge_is_opt_in" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.tf_apply_services.policy, aws_iam_role_policy.tf_apply_iam.policy, aws_iam_role_policy.tf_apply_state.policy] : [
        for s in jsondecode(policy).Statement : [
          for action in flatten([s.Action]) : !startswith(action, "bedrock:") && action != "*"
        ]
      ]
    ]))
    error_message = "apply role must not hold bedrock: actions or a bare wildcard"
  }
  assert {
    condition     = !contains([for s in jsondecode(aws_iam_role_policy.tf_apply_services.policy).Statement : s.Sid], "PublicEdge")
    error_message = "Route 53, ACM and WAF are granted only when manage_public_edge is true"
  }
}

run "apply_role_gets_edge_permissions_on_request" {
  command = plan

  variables {
    manage_public_edge = true
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.tf_apply_services.policy).Statement : s.Action if s.Sid == "PublicEdge"
    ]) == ["acm:*", "route53:*", "wafv2:*"]
    error_message = "edge statement"
  }
}

run "image_push_role_is_limited_to_the_repositories_and_signing_key" {
  command = plan

  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.image_push.policy).Statement : s.Resource if s.Sid == "PushImages"
      ]) == [
      "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-app",
      "arn:aws:ecr:us-east-1:111122223333:repository/cmp-unit-agent",
    ]
    error_message = "push is limited to the two repositories"
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.image_push.policy).Statement : s if s.Sid == "SignImages"
    ]).Resource == "arn:aws:kms:us-east-1:111122223333:key/11111111-1111-1111-1111-111111111111"
    error_message = "signing is limited to the signing key"
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.image_push.policy).Statement :
      s.Action == "ecr:GetAuthorizationToken" if s.Resource == "*"
    ])
    error_message = "the only grant on every resource is the registry login"
  }
}
