import { createInterface } from 'node:readline/promises';

export function createManualLineReader({
  input,
  output
} = {}) {
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input?.isTTY && output?.isTTY)
  });

  return {
    readLine(prompt = 'logwork> ') {
      return rl.question(prompt);
    },
    close() {
      rl.close();
    }
  };
}
