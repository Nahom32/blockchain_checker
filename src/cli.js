import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { printer, processIO } from './output.js';
import * as checkLocal from './commands/check-local.js';
import * as compare from './commands/compare.js';
import * as tamper from './commands/tamper.js';
import * as verify from './commands/verify.js';

// Entry point: blockchain-checker <command> [options]

export const COMMANDS = { verify, compare, tamper, 'check-local': checkLocal };

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const list = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
    .join('\n');
  return `Usage: blockchain-checker <command> [options]

Commands:
${list}

Run 'blockchain-checker <command> --help' for a command's options.`;
}

/**
 * @param {string[]} argv arguments after the program name
 * @param {import('./output.js').IO} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = processIO()) {
  const print = printer(io);
  const [name, ...rest] = argv;

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    print.log(usage());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    print.error(`Unknown command '${name}'.\n\n${usage()}`);
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    print.log(command.usage);
    return 0;
  }
  return command.run(rest, io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
