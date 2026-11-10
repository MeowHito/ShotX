import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NoPasswordError, readPassword } from './read-password';

describe('readPassword', () => {
  it('resolves the first line of piped stdin', async () => {
    const out = new PassThrough();
    await expect(
      readPassword('pw: ', Readable.from(['fake-password-1\n', 'ignored\n']), out),
    ).resolves.toBe('fake-password-1');
  });

  it('resolves a last line without a trailing newline', async () => {
    await expect(
      readPassword('pw: ', Readable.from(['fake-password-2']), new PassThrough()),
    ).resolves.toBe('fake-password-2');
  });

  it('rejects when stdin closes without a line', async () => {
    await expect(readPassword('pw: ', Readable.from([]), new PassThrough())).rejects.toBeInstanceOf(
      NoPasswordError,
    );
  });

  it('never writes the password to the output', async () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => chunks.push(c.toString()));
    await readPassword('pw: ', Readable.from(['fake-password-3\n']), out);
    expect(chunks.join('')).not.toContain('fake-password-3');
  });

  it('on a terminal shows the prompt and echoes nothing typed', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => chunks.push(c.toString()));
    const pending = readPassword('pw: ', input, out);
    input.write('fake-password-4\r');
    await expect(pending).resolves.toBe('fake-password-4');
    expect(chunks.join('')).not.toContain('fake-password-4');
    expect(chunks.join('')).toContain('pw: ');
  });

  it('rejects on Ctrl-C at a terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const pending = readPassword('pw: ', input, new PassThrough());
    input.write('\u0003');
    await expect(pending).rejects.toBeInstanceOf(NoPasswordError);
  });
});
