import { ToolDefinition } from './types.js';
import { SkillRegistry, formatSkillForModel } from '../skills/skillLoader.js';

interface UseSkillArgs {
  name: string;
}

/**
 * `use_skill`: loads a skill's full instructions into the conversation.
 * The output is deliberately NOT run through truncateToolOutput (skills can exceed
 * the 16k-char tool cap) and carries the <skill ...> tag so pruning leaves it alone.
 */
export function createUseSkillTool(registry: SkillRegistry): ToolDefinition<UseSkillArgs> {
  return {
    name: 'use_skill',
    description:
      'Loads the full step-by-step instructions of a skill listed in the "Skills" section of the system prompt. ' +
      'Call it BEFORE starting a task that matches a skill, then follow the returned instructions.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name as listed in the system prompt (e.g. "spec-to-tasks").',
        },
      },
      required: ['name'],
    },
    execute: async (args) => {
      if (!args?.name) return 'Error: Parameter "name" is required.';

      const skill = registry.get(args.name);
      if (!skill) {
        const names = registry.available().map((s) => s.name).join(', ') || '(none)';
        return `Error: Unknown skill "${args.name}". Available skills: ${names}`;
      }

      const missing = registry.missingRequirements(skill);
      if (missing.length > 0) {
        return `Error: Skill "${skill.name}" is unavailable in this harness: it requires ${missing.join(', ')} (no matching tool is registered).`;
      }

      return formatSkillForModel(skill, registry);
    },
  };
}
