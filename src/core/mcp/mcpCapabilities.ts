import { isIssueCreationTool } from '../issues/issuePublishing.js';
import type { McpCapabilities } from './types.js';

/** `mcp__jira__createJiraIssue` -> `createJiraIssue`; `jira_create_issue` -> `jiracreateissue` (for matching only). */
const normalized = (name: string) => (name.split('__').pop() ?? name).replace(/[_-]/g, '').toLowerCase();

/** A tool that lists the projects the signed-in person can see: `getVisibleJiraProjects`, `list_projects`, `jira_get_all_projects`... */
export function isProjectListTool(name: string): boolean {
  return /^(jira)?(get|list|search)(all|visible)?(jira)?projects$/.test(normalized(name));
}

/** A tool that links two issues: `createJiraIssueLink`, `jira_create_issue_link`, `linkIssues`... */
export function isIssueLinkTool(name: string): boolean {
  return /^(jira)?(create|add)(jira)?issuelink$/.test(normalized(name)) || /^(jira)?link(jira)?issues$/.test(normalized(name));
}

/**
 * Tools the harness never hands to the agent, whatever the server offers: they destroy things in the tracker.
 * Everything else a server offers (read, create, edit, link) is available; the person confirms before the pipeline publishes.
 */
export function isDestructiveMcpTool(name: string): boolean {
  const base = (name.split('__').pop() ?? name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(^|[_-])(delete|destroy|remove|archive|purge)([_-]|$)/.test(base);
}

/** What a server can do for the pipeline, from the names of the tools it offers. */
export function assessMcpCapabilities(toolNames: string[]): McpCapabilities {
  return {
    createsIssues: toolNames.some(isIssueCreationTool),
    listsProjects: toolNames.some(isProjectListTool),
    linksIssues: toolNames.some(isIssueLinkTool),
  };
}
