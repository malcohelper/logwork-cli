import { generateDiagnosticsReport } from '../lib/diagnostics.mjs';

export async function run(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.length) {
    throw new Error(`Unknown doctor option: ${args[0]}`);
  }

  const result = await generateDiagnosticsReport();
  console.log(result.summary);
  console.log('Send this sanitized file to the developer. Do not send raw curl logs, cookies, passwords, OTPs, or tokens.');
}

function printHelp() {
  console.log(`Usage:
  logwork doctor

Checks your setup and writes a sanitized support report under ~/.logwork-cli/diagnostics.
The report redacts tokens, cookies, passwords, OTPs, auth codes, and raw HTML.
`);
}
