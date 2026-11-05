#!/usr/bin/env node

import { generateDiagnosticsReport } from './lib/diagnostics.mjs';
import { isMainModule } from './lib/entrypoint.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.length) {
    throw new Error(`Unknown diagnostics option: ${args[0]}`);
  }

  const result = await generateDiagnosticsReport();
  console.log(result.summary);
  console.log('Send this sanitized file to the developer. Do not send raw curl logs, cookies, passwords, OTPs, or tokens.');
}

function printHelp() {
  console.log(`Usage:
  logwork-helper diagnostics

Writes a sanitized support report under ~/.logwork-helper/diagnostics.
The report redacts tokens, cookies, passwords, OTPs, auth codes, and raw HTML.
`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
