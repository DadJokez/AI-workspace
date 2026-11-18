output "vpc_id" {
  description = "Id of the VPC, created or adopted."
  value       = local.vpc_id
}

output "app_subnet_ids" {
  description = "Subnets of the services."
  value       = local.app_subnet_ids
}

output "data_subnet_ids" {
  description = "Subnets of the database."
  value       = local.data_subnet_ids
}

output "public_subnet_ids" {
  description = "Subnets of a public load balancer; empty when there are none."
  value       = local.public_subnet_ids
}

output "agentcore_subnet_ids" {
  description = "App subnets in an availability zone AgentCore Browser supports."
  value       = local.agentcore_subnet_ids
}

output "security_group_ids" {
  description = "Security group ids by workload: alb, web, worker, browser_proxy, studio_browser, deploy_task, db, agent_runtime."
  value = {
    for name in ["alb", "web", "worker", "browser_proxy", "studio_browser", "deploy_task", "db", "agent_runtime"] :
    name => aws_security_group.this[name].id
  }
}

output "interface_endpoint_services" {
  description = "Services that have an interface endpoint; empty outside firewall mode."
  value       = sort(local.interface_endpoints)
}

output "proxy_url" {
  description = "Forward proxy the workloads use, or an empty string when there is none."
  value       = local.proxy_url
}

output "no_proxy" {
  description = "NO_PROXY value: hosts the workloads reach without the proxy."
  value       = local.no_proxy
}
