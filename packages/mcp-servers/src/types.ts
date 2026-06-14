export interface PlaceholderMcpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
