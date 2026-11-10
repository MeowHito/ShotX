import { ContractError, errorFromResponse, NetworkError } from '../api/errors';
import { type SignInStepView, signInStepViewSchema } from './protocol';

/**
 * Posts one sign-in step to the admin app's own route handler (same origin, JSON). Resolves with
 * the next step; rejects with ApiError (a code such as MFA_INVALID), NetworkError or
 * ContractError. The body (a password or a code) is sent once and kept nowhere.
 */
export async function postSignInStep(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<SignInStepView> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : 'Network request failed');
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    json = undefined;
  }
  if (!response.ok) throw errorFromResponse(response.status, json);
  const parsed = signInStepViewSchema.safeParse(json);
  if (!parsed.success) throw new ContractError(response.status, 'Unexpected sign-in answer');
  return parsed.data;
}
