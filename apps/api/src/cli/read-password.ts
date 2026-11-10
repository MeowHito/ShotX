import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class NoPasswordError extends Error {
  constructor() {
    super('No password given on stdin');
    this.name = 'NoPasswordError';
  }
}

/**
 * Reads one line from `input` (stdin by default); on a terminal the typed characters are not
 * echoed. Settles exactly once: the first line resolves, and closing without a line rejects.
 * (Resolving after `rl.close()` used to lose the line, because `close` fires synchronously.)
 */
export function readPassword(
  prompt: string,
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = input.isTTY === true;
    const rl = createInterface({ input, output, terminal: tty });
    let settled = false;
    if (tty) {
      output.write(prompt);
      // Swallow the echo of typed characters.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    }
    rl.once('line', (line) => {
      settled = true;
      resolve(line);
      rl.close();
      if (tty) output.write('\n');
    });
    // Ctrl-C on a terminal: abort through the reject path instead of hanging with exit code 0.
    rl.once('SIGINT', () => rl.close());
    rl.once('close', () => {
      if (!settled) {
        settled = true;
        reject(new NoPasswordError());
      }
    });
  });
}
