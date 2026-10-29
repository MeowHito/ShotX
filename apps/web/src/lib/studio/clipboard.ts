import { ClientError } from '@/lib/errors/messages';

/** Copies text to the clipboard, or throws ClientError('client.copyFailed'). */
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    throw new ClientError('client.copyFailed');
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new ClientError('client.copyFailed');
  }
}
