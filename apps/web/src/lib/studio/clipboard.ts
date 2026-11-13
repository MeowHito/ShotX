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

/**
 * Copies text that isn't known yet (e.g. a link the API is still creating). Call it in the click
 * or submit handler itself, before any await: Safari allows a copy only during the user's
 * gesture, and a ClipboardItem built from a promise keeps that permission until the text
 * arrives. Without ClipboardItem it waits for the text and uses writeText. Resolves with the
 * text; rejects with the promise's error, or ClientError('client.copyFailed').
 */
export async function copyToClipboardWhenReady(text: Promise<string>): Promise<string> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.write !== undefined && typeof ClipboardItem !== 'undefined') {
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    let copied: Promise<void>;
    try {
      copied = clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } catch {
      copied = Promise.reject(new Error('ClipboardItem refused'));
    }
    const value = await text;
    try {
      await copied;
      return value;
    } catch {
      // Fall through to writeText (some browsers refuse promise items).
    }
  }
  const value = await text;
  await copyToClipboard(value);
  return value;
}
