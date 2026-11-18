#!/usr/bin/env node
import pc from 'picocolors';
import { loadConfig, AliaConfig } from './config.js';
import { createAliaClient, fetchAvailableModels } from './client.js';
import { ToolRegistry } from './tools/index.js';
import { SafetyChecker } from './safety/safetyChecker.js';
import { ContextManager } from './context/contextManager.js';
import { AliaAgent, DEFAULT_SYSTEM_PROMPT } from './agent/agentLoop.js';
import { TerminalUI } from './ui/terminal.js';
import { DynamicPrompt, registerSkillCommands } from './ui/prompt.js';
import { SkillRegistry, buildSkillCatalog, buildSkillInvocationPrompt } from './skills/skillLoader.js';
import { createUseSkillTool } from './tools/useSkill.js';
import { createRunSubagentTool } from './tools/runSubagent.js';
import { FileIndex } from './ui/fileIndex.js';
import { resolveFileMentions } from './context/fileMentions.js';

interface CliArgs {
  prompt?: string;
  model?: string;
  config?: string;
  autoApprove?: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--prompt') {
      result.prompt = args[++i];
    } else if (arg === '-m' || arg === '--model') {
      result.model = args[++i];
    } else if (arg === '-c' || arg === '--config') {
      result.config = args[++i];
    } else if (arg === '--auto-approve') {
      result.autoApprove = true;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return result;
}

function printHelp() {
  console.log(`
${pc.bold(pc.cyan('ALIA HARNESS - AI Agent CLI'))}

${pc.bold('USAGE:')}
  npx tsx src/index.ts [options]
  node dist/index.js [options]

${pc.bold('OPTIONS:')}
  -p, --prompt <string>    Execute a single prompt and exit (non-interactive mode)
  -m, --model <name>       Choose model id (default: from alia-config.json)
  -c, --config <path>      Path to custom configuration file
  --auto-approve           Auto-approve potentially destructive commands (skip safety prompt)
  -h, --help               Display this help message

${pc.bold('FILE MENTIONS (type "@" for live interactive preview):')}
  @path/to/file            Attach a file to your prompt (contents added to context)
  @path/to/dir/            Attach a directory (its entries are listed for the model)

  Type @ followed by a query to filter workspace files, then:
  Tab inserts the highlighted file, ↑/↓ navigate, Enter confirms, Esc dismisses.

${pc.bold('SLASH COMMANDS (type "/" for live interactive preview):')}
  /help                    Show available slash commands
  /tools                   List all available tools and parameters
  /skills                  List skills and whether they are available
  /<skill-name> [input]    Run a skill directly (e.g. /spec-to-tasks @docs/specs/login.md)
  /models                 List models from configuration & endpoint
  /model <id>              Switch active model on the fly
  /clear                   Reset conversation history
  /tokens                  Show estimated context tokens used
  /exit, /quit             Exit the agent harness
`);
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));

  let config: AliaConfig;
  try {
    config = loadConfig(cliArgs.config);
  } catch (err: any) {
    TerminalUI.printError(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  const toolRegistry = new ToolRegistry();

  // Skills: scan folders, expose the use_skill tool, and advertise a catalog in the system prompt.
  const skills = new SkillRegistry({
    getToolNames: () => toolRegistry.getAll().map((t) => t.name),
    cwd: process.cwd(),
  });
  skills.load();
  toolRegistry.register(createUseSkillTool(skills));
  const catalog = buildSkillCatalog(skills);
  const systemPrompt = catalog ? `${DEFAULT_SYSTEM_PROMPT}\n\n${catalog}` : DEFAULT_SYSTEM_PROMPT;

  const safetyChecker = new SafetyChecker(cliArgs.autoApprove ?? false);

  const selectedModelId = cliArgs.model || config.models[0].id;
  let clientInstance;
  try {
    clientInstance = createAliaClient(config, selectedModelId);
  } catch (err: any) {
    TerminalUI.printError(err.message);
    process.exit(1);
  }

  const contextManager = new ContextManager({
    maxInputTokens: clientInstance.modelConfig.maxInputTokens || 128000,
  });

  const agent = new AliaAgent({
    client: clientInstance.client,
    model: clientInstance.model,
    modelConfig: clientInstance.modelConfig,
    toolRegistry,
    safetyChecker,
    contextManager,
    workingDirectory: process.cwd(),
    systemPrompt,
  });

  // Subagents: registered after the agent exists so the tool can read the live model/client.
  // Callers see it in the tool list; a child gets a copy of the registry without it.
  toolRegistry.register(
    createRunSubagentTool({
      getClient: () => clientInstance.client,
      getModel: () => ({ id: agent.getModel(), config: agent.getModelConfig() }),
      getRegistry: () => toolRegistry,
      systemPrompt,
      getSkills: () => skills,
    })
  );

  const skippedSkills = registerSkillCommands(skills.available());
  for (const w of skills.warnings) TerminalUI.printInfo(`skills: ${w}`);
  for (const name of skippedSkills) {
    TerminalUI.printInfo(`skills: "${name}" clashes with a built-in command; use it via use_skill only.`);
  }

  /**
   * Turns `/skill-name <input>` into the prompt for the agent loop, or returns null when
   * the command is not a skill (errors for known-but-unavailable skills are printed).
   */
  const resolveSkillCommand = (cmd: string, input: string): string | null => {
    const skill = skills.get(cmd);
    if (!skill) return null;
    const missing = skills.missingRequirements(skill);
    if (missing.length > 0) {
      TerminalUI.printError(
        `Skill "${skill.name}" is unavailable: it requires ${missing.join(', ')} (no matching tool is registered in this harness).`
      );
      return '';
    }
    const { prompt, attachments, errors } = resolveFileMentions(input, process.cwd());
    TerminalUI.printAttachedFiles(attachments);
    for (const err of errors) console.log(pc.yellow(`⚠️  ${err}`));
    TerminalUI.printInfo(`Skill loaded: ${skill.name}`);
    return buildSkillInvocationPrompt(skill, skills, prompt);
  };

  // Non-interactive single-prompt mode
  if (cliArgs.prompt) {
    console.log(pc.bold(pc.cyan(`\nExecuting prompt with model [${agent.getModel()}]:`)));
    console.log(pc.white(`> ${cliArgs.prompt}\n`));

    if (cliArgs.prompt.startsWith('/')) {
      const cmd = cliArgs.prompt.trim().split(/\s+/)[0];
      const skillPrompt = resolveSkillCommand(cmd, cliArgs.prompt.trim().slice(cmd.length));
      if (skillPrompt === '') process.exit(1);
      if (skillPrompt !== null) {
        await agent.run(skillPrompt);
        return;
      }
    }

    const { prompt, attachments, errors } = resolveFileMentions(cliArgs.prompt, process.cwd());
    TerminalUI.printAttachedFiles(attachments);
    for (const err of errors) console.log(pc.yellow(`⚠️  ${err}`));
    await agent.run(prompt);
    return;
  }

  // Interactive REPL mode
  TerminalUI.printBanner(
    agent.getModel(),
    config.vendor || config.name,
    clientInstance.modelConfig.url
  );

  const fileIndex = new FileIndex(process.cwd());
  const prompt = new DynamicPrompt(TerminalUI.printUserPrompt(), fileIndex);

  const askPrompt = async () => {
    while (true) {
      let userInput: string;
      try {
        userInput = await prompt.ask();
      } catch {
        break;
      }

      const trimmed = userInput.trim();
      if (!trimmed) continue;

      // Handle Slash Commands
      if (trimmed.startsWith('/')) {
        const [cmd, ...cmdArgs] = trimmed.split(' ');
        switch (cmd.toLowerCase()) {
          case '/exit':
          case '/quit':
            console.log(pc.yellow('Exiting Alia Harness. Goodbye! 👋'));
            process.exit(0);

          case '/clear':
            agent.reset();
            TerminalUI.printSuccess('Conversation history cleared.');
            continue;

          case '/help':
            printHelp();
            continue;

          case '/tools': {
            console.log(pc.bold('\nRegistered Tools:'));
            for (const tool of toolRegistry.getAll()) {
              console.log(`• ${pc.bold(pc.cyan(tool.name))}: ${tool.description}`);
              console.log(`  Parameters: ${JSON.stringify(tool.parameters.properties, null, 2)}`);
            }
            console.log();
            continue;
          }

          case '/skills': {
            const all = skills.all();
            if (all.length === 0) {
              console.log(pc.yellow('\nNo skills found. Add folders with a SKILL.md to ./skills, ~/.alia/skills or ./.alia/skills.\n'));
              continue;
            }
            console.log(pc.bold(`\nSkills (${all.length}) — run with /<name> [input], or the model loads them via use_skill:`));
            for (const s of all) {
              const missing = skills.missingRequirements(s);
              const status = missing.length === 0 ? '' : pc.red(` [unavailable: needs ${missing.join(', ')}]`);
              const desc = s.description.replace(/\s+/g, ' ');
              console.log(`• ${pc.bold(pc.cyan('/' + s.name))} ${pc.dim(`(${s.source})`)}${status}`);
              console.log(`  ${pc.dim(desc.length > 160 ? desc.slice(0, 157) + '...' : desc)}`);
            }
            console.log();
            continue;
          }

          case '/models':
          case '/model': {
            if (cmdArgs.length > 0) {
              const newModel = cmdArgs[0];
              const foundInConfig = config.models.find(
                (m) => m.id === newModel || m.name === newModel
              );
              if (foundInConfig) {
                agent.setModel(foundInConfig.id, foundInConfig);
                TerminalUI.printSuccess(`Switched active model to: ${pc.bold(foundInConfig.id)}`);
              } else {
                // Dynamically allow switching to any remote model
                const remoteModels = await fetchAvailableModels(clientInstance.client);
                if (remoteModels.includes(newModel)) {
                  agent.setModel(newModel, {
                    id: newModel,
                    name: newModel,
                    url: clientInstance.modelConfig.url,
                    toolCalling: true,
                    maxInputTokens: 128000,
                    maxOutputTokens: 16000,
                  });
                  TerminalUI.printSuccess(`Switched active model to: ${pc.bold(newModel)}`);
                } else {
                  TerminalUI.printError(
                    `Model "${newModel}" not found. Available on endpoint: ${remoteModels.join(', ')}`
                  );
                }
              }
            } else {
              console.log(pc.bold('\nConfigured Models:'));
              for (const m of config.models) {
                const active = m.id === agent.getModel() ? pc.green(' (active)') : '';
                console.log(`• ${pc.bold(m.id)} - ${m.name}${active}`);
              }

              const loading = TerminalUI.startThinking('Loading models');
              const remoteModels = await fetchAvailableModels(clientInstance.client).finally(() =>
                loading.stop()
              );

              if (remoteModels.length > 0) {
                console.log(pc.bold('\nEndpoint Models (switch with /model <id>):'));
                for (const rModel of remoteModels) {
                  const active = rModel === agent.getModel() ? pc.green(' (active)') : '';
                  console.log(`• ${pc.cyan(rModel)}${active}`);
                }
              }
              console.log();
            }
            continue;
          }

          case '/tokens': {
            const tokens = contextManager.estimateMessagesTokens(agent.getMessages());
            const limit = clientInstance.modelConfig.maxInputTokens || 128000;
            const pct = ((tokens / limit) * 100).toFixed(1);
            console.log(
              pc.cyan(
                `Estimated Context Window: ${tokens} / ${limit} tokens (${pct}%) across ${agent.getMessages().length} messages.`
              )
            );
            continue;
          }

          default: {
            // `/skill-name [input]` runs a skill directly
            const skillPrompt = resolveSkillCommand(cmd, trimmed.slice(cmd.length));
            if (skillPrompt === null) {
              TerminalUI.printError(`Unknown command "${cmd}". Type /help for assistance.`);
              continue;
            }
            if (skillPrompt === '') continue;
            try {
              await agent.run(skillPrompt);
            } catch (err: any) {
              TerminalUI.printError(`Execution error: ${err.message}`);
            }
            continue;
          }
        }
      }

      // Execute prompt in the agent loop
      try {
        // Resolve @file mentions into attached context, then run the agent loop
        const { prompt: enrichedPrompt, attachments, errors } = resolveFileMentions(
          trimmed,
          process.cwd()
        );
        TerminalUI.printAttachedFiles(attachments);
        for (const err of errors) console.log(pc.yellow(`⚠️  ${err}`));
        await agent.run(enrichedPrompt);
      } catch (err: any) {
        TerminalUI.printError(`Execution error: ${err.message}`);
      }
    }
  };

  await askPrompt();
}

main().catch((err) => {
  TerminalUI.printError(`Fatal error: ${err.message}`);
  process.exit(1);
});
