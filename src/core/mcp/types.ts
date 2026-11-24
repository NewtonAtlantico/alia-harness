/**
 * Types of the MCP (Model Context Protocol) connection used to send the pipeline's tasks to a tracker such as Jira.
 * Types only: `mcpConnection.ts` connects, `mcpTools.ts` turns a server's tools into agent tools.
 */

export type McpPreset = 'atlassian' | 'custom';
export type McpAuthKind = 'oauth' | 'token' | 'none';

/** How the server is reached: an address (streamable HTTP, SSE as a fallback) or a command that runs on this computer (stdio). */
export type McpTransportConfig =
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args: string[]; env: McpEnvVar[] };

export interface McpEnvVar {
  name: string;
  /** Absent for a secret variable whose value is stored encrypted (it is merged back in before the server starts). */
  value?: string;
  secret: boolean;
}

/** What is saved about a server. No secret is ever in it. */
export interface McpServerConfig {
  /** Short id used in tool names: `mcp__<id>__<tool>`. Letters, digits and `-` only. */
  id: string;
  label: string;
  preset: McpPreset;
  transport: McpTransportConfig;
  auth: McpAuthKind;
}

/** The secrets of one server, kept encrypted by the app and handed to the engine in memory. */
export interface McpCredentials {
  /** Bearer token (auth `token`). */
  token?: string;
  /** Values of the secret environment variables of a local command, by name. */
  env?: Record<string, string>;
  /** OAuth state kept between runs (auth `oauth`): the client registered with the server and the tokens it gave. */
  oauth?: { clientInformation?: unknown; tokens?: unknown };
}

/** A server with its secrets: what the engine needs to connect. Lives in memory only. */
export interface McpResolvedServer {
  config: McpServerConfig;
  credentials: McpCredentials;
}

/** What a server can do for the pipeline, read from the names of its tools. */
export interface McpCapabilities {
  createsIssues: boolean;
  listsProjects: boolean;
  linksIssues: boolean;
}

export type McpFailure = 'unreachable' | 'unauthorized' | 'needs_sign_in' | 'no_issue_tool' | 'timeout' | 'bad_config' | 'cancelled' | 'other';

export interface McpTestResult {
  /** True only when the server is reachable and can create issues. */
  ok: boolean;
  reason?: McpFailure;
  /** Why, in English as the server or the SDK said it, for the user's support (no secret). */
  message?: string;
  toolCount: number;
  capabilities: McpCapabilities;
  /** Who is signed in, when the server says so. */
  account?: string;
}

export interface McpProject {
  key: string;
  name: string;
  /** The site it belongs to (Atlassian: the cloud site's address). */
  site?: string;
}

export interface McpProjectList {
  /** False when the server has no tool to list projects: the person types the project key. */
  listed: boolean;
  projects: McpProject[];
}

/** Where the pipeline's tasks go in Jira. Saved in the project, in `docs/tasks/.jira-target.json`, and read by the `add-tasks-to-jira` skill. */
export interface JiraTarget {
  serverId: string;
  projectKey: string;
  projectName?: string;
  /** The Jira site (address or name) when the server serves more than one. */
  site?: string;
}

export const JIRA_TARGET_FILE = 'docs/tasks/.jira-target.json';
