#!/usr/bin/env node
import pc from 'picocolors';
import { loadConfig, AliaConfig } from './config.js';
import { createAliaClient, fetchAvailableModels } from './client.js';
import { ToolRegistry } from './tools/index.js';
import { SafetyChecker } from './safety/safetyChecker.js';
import { ContextManager } from './context/contextManager.js';
import { AliaAgent } from './agent/agentLoop.js';
import { TerminalUI } from './ui/terminal.js';
import { DynamicPrompt } from './ui/prompt.js';
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
  /models                  List models from configuration & endpoint
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

              TerminalUI.printThinkingStatus();
              const remoteModels = await fetchAvailableModels(clientInstance.client);
              TerminalUI.clearLine();

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

          default:
            TerminalUI.printError(`Unknown command "${cmd}". Type /help for assistance.`);
            continue;
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
