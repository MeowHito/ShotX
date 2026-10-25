import type { ConsentPurpose } from '../domain';

/**
 * Which share gates apply before a consent of each purpose is given or used, and so before
 * Rekognition is called. The API checks them in the usual order (token lookup, availability,
 * login, password, feature flag) and skips the ones that are `false`.
 *
 * - `face_search`: every gate. Giving the consent (`POST /s/:token/consent` with
 *   `purpose: 'face_search'`) and scanning (`POST /s/:token/face-search`) need an open share
 *   (SHARE_EXPIRED), the login and password gates (LOGIN_REQUIRED, PASSWORD_REQUIRED) and
 *   FACE_SEARCH_ENABLED (FEATURE_DISABLED).
 * - `face_deletion`: the token lookup only (unknown token: NOT_FOUND). "ขอลบใบหน้าของฉัน" is a PDPA
 *   data-subject right: it works on revoked, expired and unavailable shares, on password and
 *   login shares without unlocking or signing in, and with FACE_SEARCH_ENABLED=false. Giving the
 *   consent (`purpose: 'face_deletion'`), reading `GET /s/:token/face-deletion` and
 *   `POST /s/:token/face-deletion` therefore never answer SHARE_EXPIRED, LOGIN_REQUIRED,
 *   PASSWORD_REQUIRED or FEATURE_DISABLED. The consent itself is still required
 *   (CONSENT_REQUIRED), and the face-search request limits apply (ADR 0007).
 *
 * Consent withdrawal (`DELETE /s/:token/consent`) needs only the token lookup, for every purpose.
 */
export interface ConsentGates {
  /** shareAvailability: SHARE_EXPIRED. */
  availability: boolean;
  /** shareAccessGate: LOGIN_REQUIRED, PASSWORD_REQUIRED. */
  access: boolean;
  /** FACE_SEARCH_ENABLED: FEATURE_DISABLED. */
  featureFlag: boolean;
}

export const CONSENT_PURPOSE_GATES = {
  face_search: { availability: true, access: true, featureFlag: true },
  face_deletion: { availability: false, access: false, featureFlag: false },
} as const satisfies Record<ConsentPurpose, ConsentGates>;

/** The gates of a purpose (see CONSENT_PURPOSE_GATES). */
export function consentGates(purpose: ConsentPurpose): ConsentGates {
  return CONSENT_PURPOSE_GATES[purpose];
}
