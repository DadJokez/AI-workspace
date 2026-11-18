# Optional RDS Proxy in front of the instance. Off by default.
#
# Clients reach the proxy exactly as they reach the instance: it carries the
# database security group, so the rules of 10-network apply to it unchanged.
# The two rules below let it reach the instance inside that group.

resource "aws_vpc_security_group_egress_rule" "proxy_to_db" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = var.db_security_group_id
  referenced_security_group_id = var.db_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "RDS Proxy to the instance"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = var.db_security_group_id
  referenced_security_group_id = var.db_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "RDS Proxy to the instance"
}

# The proxy reads the one login it connects with, and nothing else.
resource "aws_iam_role" "db_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name                 = "${var.name_prefix}-db-proxy"
  path                 = "/comparative/${var.env}/"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "rds.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "db_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name = "read-proxy-login"
  role = aws_iam_role.db_proxy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadProxyLogin"
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.this["db-proxy-auth"].arn
      },
      {
        Sid      = "DecryptProxyLogin"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = var.secrets_kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${var.aws_region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_db_proxy" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  name          = "${var.name_prefix}-db"
  engine_family = "POSTGRESQL"
  require_tls   = true
  role_arn      = aws_iam_role.db_proxy[0].arn

  vpc_subnet_ids         = var.data_subnet_ids
  vpc_security_group_ids = [var.db_security_group_id]

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.this["db-proxy-auth"].arn
  }

  depends_on = [aws_iam_role_policy.db_proxy]
}

resource "aws_db_proxy_default_target_group" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name = aws_db_proxy.this[0].name
}

resource "aws_db_proxy_target" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name          = aws_db_proxy.this[0].name
  target_group_name      = aws_db_proxy_default_target_group.this[0].name
  db_instance_identifier = aws_db_instance.this.identifier
}
