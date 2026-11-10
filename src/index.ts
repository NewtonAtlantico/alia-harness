#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { loadConfig, AliaConfig } from './config.js';
import { createAliaClient } from './client.js';
import { ToolRegistry } from './tools/index.js';
import { SafetyChecker } from './safety/safetyChecker.js';
import { ContextManager } from './context/contextManager.js';
import { AliaAgent } from './agent/agentLoop.js';
import { TerminalUI } from './ui/terminal.js';

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
  npm start -- [options]

${pc.bold('OPTIONS:')}
  -p, --prompt <string>    Execute a single prompt and exit (non-interactive mode)
  -m, --model <name>       Choose model id (default: from alia-config.json)
  -c, --config <path>      Path to custom configuration file
  --auto-approve           Auto-approve potentially destructive commands (skip safety prompt)
  -h, --help               Display this help message

${pc.bold('SLASH COMMANDS (in interactive REPL):')}
  /help                    Show available slash commands
  /tools                   List all available tools and parameters
  /models                  List models from configuration or switch model (/model <id>)
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
  });

  // Non-interactive single-prompt mode
  if (cliArgs.prompt) {
    console.log(pc.bold(pc.cyan(`\nExecuting prompt with model [${agent.getModel()}]:`)));
    console.log(pc.white(`> ${cliArgs.prompt}\n`));
    await agent.run(cliArgs.prompt);
    return;
  }

  // Interactive REPL mode
  TerminalUI.printBanner(
    agent.getModel(),
    config.vendor || config.name,
    clientInstance.modelConfig.url
  );

  const rl = readline.createInterface({ input, output });

  const askPrompt = async () => {
    while (true) {
      let userInput: string;
      try {
        userInput = await rl.question(TerminalUI.printUserPrompt());
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
            rl.close();
            return;

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

          case '/models':
          case '/model': {
            if (cmdArgs.length > 0) {
              const newModel = cmdArgs[0];
              const found = config.models.find(m => m.id === newModel || m.name === newModel);
              if (found) {
                agent.setModel(found.id, found);
                TerminalUI.printSuccess(`Switched active model to: ${pc.bold(found.id)}`);
              } else {
                TerminalUI.printError(
                  `Model "${newModel}" not found in config. Available: ${config.models.map(m => m.id).join(', ')}`
                );
              }
            } else {
              console.log(pc.bold('\nConfigured Models:'));
              for (const m of config.models) {
                const active = m.id === agent.getModel() ? pc.green(' (active)') : '';
                console.log(`• ${pc.bold(m.id)} - ${m.name} (${m.url})${active}`);
              }
              console.log(pc.dim('\nTo switch model: /model <model_id>\n'));
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

          default:
            TerminalUI.printError(`Unknown command "${cmd}". Type /help for assistance.`);
            continue;
        }
      }

      // Execute prompt in the agent loop
      try {
        await agent.run(trimmed);
      } catch (err: any) {
        TerminalUI.printError(`Execution error: ${err.message}`);
      }
    }
  };

  try {
    await askPrompt();
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  TerminalUI.printError(`Fatal error: ${err.message}`);
  process.exit(1);
});
