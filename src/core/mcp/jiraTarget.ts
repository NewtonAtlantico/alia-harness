import fs from 'node:fs';
import path from 'node:path';
import { JIRA_TARGET_FILE, type JiraTarget } from './types.js';

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);

/** Reads `docs/tasks/.jira-target.json`: where this project's tasks go in Jira. Null when absent or unreadable. */
export function readJiraTarget(workspace: string): JiraTarget | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspace, JIRA_TARGET_FILE), 'utf8')) as Record<string, unknown>;
    const serverId = str(raw.serverId, 40);
    const projectKey = str(raw.projectKey, 100);
    if (!serverId || !projectKey) return null;
    const projectName = str(raw.projectName, 200);
    const site = str(raw.site, 500);
    return { serverId, projectKey, ...(projectName ? { projectName } : {}), ...(site ? { site } : {}) };
  } catch {
    return null;
  }
}

/**
 * Saves the target (or with null removes it). The file holds no secret, so it can be committed with the tasks.
 * The `add-tasks-to-jira` skill reads it; it sits next to `.jira-sync.json`.
 */
export function writeJiraTarget(workspace: string, target: JiraTarget | null): JiraTarget | null {
  const file = path.join(workspace, JIRA_TARGET_FILE);
  if (target === null) {
    fs.rmSync(file, { force: true });
    return null;
  }
  const clean: JiraTarget = {
    serverId: target.serverId,
    projectKey: target.projectKey.trim().toUpperCase(),
    ...(target.projectName?.trim() ? { projectName: target.projectName.trim() } : {}),
    ...(target.site?.trim() ? { site: target.site.trim() } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return clean;
}
