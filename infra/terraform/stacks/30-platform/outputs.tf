# What a human needs when DNS is not managed here (route53_zone_id is null):
# the name the record for domain_name must point at. What other stacks need is
# published to SSM in main.tf instead.

output "alb_dns_name" {
  description = "DNS name of the load balancer."
  value       = aws_lb.this.dns_name
}
