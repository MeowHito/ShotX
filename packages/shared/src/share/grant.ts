import { z } from 'zod';
import type { FaceMatchBucket, ShareMode } from '../domain';
import type { FaceThresholds } from '../config/face';
import { type Viewer, viewerKey } from './viewer';

/**
 * Redis keys of the share routes. Each builder returns the key without the service prefix; the
 * API prepends its own (`shotx:<stage>:api:`). ADR 0005: every key is written with a TTL, and a
 * failed write denies the request (fails closed).
 *
 *   face-scan:{shareId}:{viewerKey}       HASH fileId -> similarity     TTL SHARE_FACE_ONLY_GRANT_TTL_SECONDS
 *   share-unlock:{shareId}:{tokenHash}    STRING password fingerprint   TTL SHARE_UNLOCK_TTL_SECONDS
 *   viewer-session:{tokenHash}            STRING users.id               TTL VIEWER_SESSION_TTL_SECONDS
 *
 * `tokenHash` is the lowercase hex SHA-256 of the cookie's opaque token, so Redis never holds a
 * usable cookie value.
 */

const uuid = z.uuid();
const SHA256_HEX = /^[0-9a-f]{64}$/;

function tokenHash(hash: string): string {
  if (!SHA256_HEX.test(hash)) throw new RangeError('tokenHash must be lowercase hex SHA-256');
  return hash;
}

/**
 * The viewer's face-search result for a share: a HASH from file id to the best similarity seen
 * (decimal text, one digit after the point). It is the face_only grant, and it backs "ไม่ใช่ฉัน"
 * feedback in every mode. Each scan merges its hits into it (mergeFaceScanResult) and resets the
 * TTL, in one MULTI (HSET + EXPIRE). Withdrawing consent deletes it. It holds file ids and
 * scores only: never face ids, boxes or image data.
 */
export function faceScanResultKey(shareId: string, viewer: Viewer): string {
  return `face-scan:${uuid.parse(shareId)}:${viewerKey(viewer)}`;
}

/**
 * Proof that this browser unlocked a password share. The value is a fingerprint of the share's
 * `password_hash` when it was unlocked (e.g. the first 16 hex characters of its SHA-256); the
 * API treats the share as locked again when it no longer matches, so changing or removing the
 * password logs everyone out.
 */
export function shareUnlockKey(shareId: string, unlockTokenHash: string): string {
  return `share-unlock:${uuid.parse(shareId)}:${tokenHash(unlockTokenHash)}`;
}

/** A signed-in viewer's session on the public routes; the value is `users.id`. */
export function viewerSessionKey(sessionTokenHash: string): string {
  return `viewer-session:${tokenHash(sessionTokenHash)}`;
}

/** One file of a face-search result. */
export interface FaceScanHit {
  fileId: string;
  /** Best similarity of any of the viewer's faces in the file, 0–100. */
  similarity: number;
}

/** Similarity as stored in the result hash: one decimal digit. */
export function formatSimilarity(similarity: number): string {
  if (!(similarity >= 0 && similarity <= 100)) {
    throw new RangeError(`similarity must be 0 to 100, got ${similarity}`);
  }
  return (Math.round(similarity * 10) / 10).toFixed(1);
}

/**
 * The fields to HSET after a scan: each hit whose similarity beats what `existing` (the current
 * hash, HGETALL) holds. Repeated scans union their results and keep the best score per file.
 */
export function mergeFaceScanResult(
  existing: Readonly<Record<string, string>>,
  hits: readonly FaceScanHit[],
): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const hit of hits) {
    uuid.parse(hit.fileId);
    const value = formatSimilarity(hit.similarity);
    const current = updates[hit.fileId] ?? existing[hit.fileId];
    if (current === undefined || Number(value) > Number(current)) updates[hit.fileId] = value;
  }
  return updates;
}

/** The group a stored similarity falls in, or null below FACE_MAYBE (never stored). */
export function faceMatchBucket(
  similarity: number,
  thresholds: FaceThresholds,
): FaceMatchBucket | null {
  if (similarity >= thresholds.strong) return 'strong';
  if (similarity >= thresholds.maybe) return 'maybe';
  return null;
}

/**
 * What a face-search result allows. In `gallery` mode the share's scope decides alone (the result
 * only backs feedback). In `face_only` mode every view, items page, download and zip entry must
 * also be a file in the viewer's result: `granted` is the hash's field names, or null when there
 * is no result (no scan yet, expired, or consent withdrawn), which allows nothing. Files outside
 * the grant are NOT_FOUND, so nothing leaks about other people's photos. The scope check
 * (isFileInShareScope) still applies to granted files: a file trashed after the scan is gone.
 */
export function faceOnlyGrantAllows(
  mode: ShareMode,
  granted: ReadonlySet<string> | null,
  fileId: string,
): boolean {
  if (mode === 'gallery') return true;
  return granted?.has(fileId) ?? false;
}
