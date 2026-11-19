#!/usr/bin/env node
import pc from 'picocolors';
import { loadConfig, AliaConfig } from '../core/config.js';
import { createSession, AliaSession } from '../core/session.js';
import { TerminalUI, cliConfirmDangerousCommand, cliAutoApproveNotice, cliAskUser } from './ui/terminal.js';
import { DynamicPrompt, setSlashCommands } from './ui/prompt.js';
import { FileIndex } from '../core/context/fileIndex.js';

interface CliArgs {
  prompt?: string;
  model?: string;
  config?: string;
  autoApprove?: boolean;
  maxSteps?: number;
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
    } else if (arg === '--max-steps') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('--max-steps needs a positive whole number.');
        process.exit(1);
      }
      result.maxSteps = n;
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
  npx tsx src/cli/index.ts [options]
  node dist/cli/index.js [options]

${pc.bold('OPTIONS:')}
  -p, --prompt <string>    Execute a single prompt and exit (non-interactive mode)
  -m, --model <name>       Choose model id (default: from alia-config.json)
  -c, --config <path>      Path to custom configuration file
  --max-steps <n>          Step cap of one run (default 100, or ALIA_MAX_STEPS)
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
  /compact                 Summarize older messages to free up context
  /tokens                  Show estimated context tokens used
  /exit, /quit             Exit the agent harness
`);
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  // The CLI's workspace is the directory it was started in. Core never reads cwd itself.
  const workspace = process.cwd();

  let config: AliaConfig;
  try {
    config = loadConfig({ baseDir: workspace, configPath: cliArgs.config });
  } catch (err: any) {
    TerminalUI.printError(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  let session: AliaSession;
  try {
    session = createSession({
      workspace,
      config,
      modelId: cliArgs.model,
      maxSteps: cliArgs.maxSteps,
      ui: TerminalUI,
      autoApprove: cliArgs.autoApprove ?? false,
      onConfirm: cliConfirmDangerousCommand,
      onAutoApprove: cliAutoApproveNotice,
      onAskUser: (request) => cliAskUser(request),
    });
  } catch (err: any) {
    TerminalUI.printError(err.message);
    process.exit(1);
  }

  // The slash menu comes from the session's command list; the terminal adds the commands only it can do.
  session.commands.register({ name: 'exit', description: 'Exit the agent harness' });
  session.commands.register({ name: 'quit', description: 'Exit the agent harness' });
  setSlashCommands(session.commands.list());
  for (const w of session.skills.warnings) TerminalUI.printInfo(`skills: ${w}`);
  for (const name of session.commands.skippedSkills()) {
    TerminalUI.printInfo(`skills: "${name}" clashes with a built-in command; use it via use_skill only.`);
  }

  /**
   * Turns `/skill-name <input>` into the prompt for the agent loop, or returns null when
   * the command is not a skill (errors for known-but-unavailable skills are printed).
   */
  const resolveSkillCommand = async (cmd: string, input: string): Promise<string | null> => {
    const resolved = await session.resolveSkill(cmd, input);
    if (resolved.status === 'not_a_skill') return null;
    if (resolved.status === 'unavailable') {
      TerminalUI.printError(resolved.message);
      return '';
    }
    TerminalUI.printAttachedFiles(resolved.attachments);
    for (const err of resolved.errors) console.log(pc.yellow(`⚠️  ${err}`));
    TerminalUI.printInfo(`Skill loaded: ${resolved.skill.name}`);
    return resolved.prompt;
  };

  // Non-interactive single-prompt mode
  if (cliArgs.prompt) {
    console.log(pc.bold(pc.cyan(`\nExecuting prompt with model [${session.getModel()}]:`)));
    console.log(pc.white(`> ${cliArgs.prompt}\n`));

    if (cliArgs.prompt.startsWith('/')) {
      const cmd = cliArgs.prompt.trim().split(/\s+/)[0];
      const skillPrompt = await resolveSkillCommand(cmd, cliArgs.prompt.trim().slice(cmd.length));
      if (skillPrompt === '') process.exit(1);
      if (skillPrompt !== null) {
        await session.run(skillPrompt);
        return;
      }
    }

    const { prompt, attachments, errors } = await session.prepareInput(cliArgs.prompt);
    TerminalUI.printAttachedFiles(attachments);
    for (const err of errors) console.log(pc.yellow(`⚠️  ${err}`));
    await session.run(prompt);
    return;
  }

  // Interactive REPL mode
  TerminalUI.printBanner(
    session.getModel(),
    config.vendor || config.name,
    session.getModelConfig().url
  );

  const fileIndex = new FileIndex(workspace);
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
            session.reset();
            TerminalUI.printSuccess('Conversation history cleared.');
            continue;

          case '/help':
            printHelp();
            continue;

          case '/tools': {
            console.log(pc.bold('\nRegistered Tools:'));
            for (const tool of session.tools.getAll()) {
              console.log(`• ${pc.bold(pc.cyan(tool.name))}: ${tool.description}`);
              console.log(`  Parameters: ${JSON.stringify(tool.parameters.properties, null, 2)}`);
            }
            console.log();
            continue;
          }

          case '/skills': {
            const all = session.skills.all();
            if (all.length === 0) {
              console.log(pc.yellow('\nNo skills found. Add folders with a SKILL.md to ./skills, ~/.alia/skills or ./.alia/skills.\n'));
              continue;
            }
            console.log(pc.bold(`\nSkills (${all.length}) — run with /<name> [input], or the model loads them via use_skill:`));
            for (const s of all) {
              const missing = session.skills.missingRequirements(s);
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
              const switched = await session.switchModel(cmdArgs[0]);
              if (switched.ok) {
                TerminalUI.printSuccess(`Switched active model to: ${pc.bold(switched.id)}`);
              } else {
                TerminalUI.printError(
                  `Model "${cmdArgs[0]}" not found. Available on endpoint: ${switched.available.join(', ')}`
                );
              }
            } else {
              console.log(pc.bold('\nConfigured Models:'));
              for (const m of config.models) {
                const active = m.id === session.getModel() ? pc.green(' (active)') : '';
                console.log(`• ${pc.bold(m.id)} - ${m.name}${active}`);
              }

              const loading = TerminalUI.startThinking('Loading models');
              const { remote: remoteModels } = await session.listModels().finally(() => loading.stop());

              if (remoteModels.length > 0) {
                console.log(pc.bold('\nEndpoint Models (switch with /model <id>):'));
                for (const rModel of remoteModels) {
                  const active = rModel === session.getModel() ? pc.green(' (active)') : '';
                  console.log(`• ${pc.cyan(rModel)}${active}`);
                }
              }
              console.log();
            }
            continue;
          }

          case '/compact': {
            // The result is reported through the session's events (printed by the terminal UI).
            const compacting = TerminalUI.startThinking('Compacting');
            try {
              await session.compact();
            } finally {
              compacting.stop();
            }
            continue;
          }

          case '/tokens': {
            const usage = session.getContextUsage();
            console.log(
              pc.cyan(
                `Estimated Context Window: ${usage.tokens} / ${usage.limit} tokens (${usage.percent.toFixed(1)}%) across ${usage.messages} messages.`
              )
            );
            continue;
          }

          default: {
            // `/skill-name [input]` runs a skill directly
            const skillPrompt = await resolveSkillCommand(cmd, trimmed.slice(cmd.length));
            if (skillPrompt === null) {
              TerminalUI.printError(`Unknown command "${cmd}". Type /help for assistance.`);
              continue;
            }
            if (skillPrompt === '') continue;
            try {
              await session.run(skillPrompt);
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
        const { prompt: enrichedPrompt, attachments, errors } = await session.prepareInput(trimmed);
        TerminalUI.printAttachedFiles(attachments);
        for (const err of errors) console.log(pc.yellow(`⚠️  ${err}`));
        await session.run(enrichedPrompt);
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
