import { deleteUncoveredFaces, type UncoveredFacesResult } from '../faces/uncovered';
import { type JobContext, mayContinue } from './context';

/**
 * `faces.expire.daily`: deletes the faces (Rekognition and rows) of every file no active face
 * index covers any more: its covering folders were switched off, passed `face_index_expires_at`
 * (last upload + FACE_INDEX_EXPIRY_DAYS, extendable), or were trashed. Runs whatever
 * FACE_SEARCH_ENABLED says (PDPA: the face index auto-expires). See deleteUncoveredFaces for
 * idempotency.
 */
export function runFacesExpire(ctx: JobContext): Promise<UncoveredFacesResult> {
  return deleteUncoveredFaces({
    db: ctx.db,
    faces: ctx.faces,
    log: ctx.log,
    now: ctx.now,
    batchSize: ctx.batchSize,
    mayContinue: () => mayContinue(ctx),
  });
}
