output "runtime_arn" {
  description = "ARN of the AgentCore runtime; the chat worker's AGENTCORE_RUNTIME_ARN."
  value       = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
}

output "browser_id" {
  description = "Id of the Studio Browser; the web service's AGENTCORE_BROWSER_ID."
  value       = aws_bedrockagentcore_browser.studio.browser_id
}

output "browser_arn" {
  description = "ARN of the Studio Browser."
  value       = aws_bedrockagentcore_browser.studio.browser_arn
}
