import { indexPhotoWorstCase } from '@shotx/face';
import { type FaceConfig, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS } from '@shotx/shared';
import { heartbeatIntervalMs } from '../sqs/heartbeat';

/** How the faces queue holds a message while it runs. */
export type QueueHold =
  /** SQS: heartbeats every visibility timeout / 3, up to 12 h from the receive. */
  | { backend: 'sqs'; visibilityTimeoutSeconds: number }
  /** BullMQ: the lock is renewed every lockDuration / 2 (lockRenewTime), with no upper limit. */
  | { backend: 'bullmq'; lockDurationMs: number };

/** Interval at which a running message's hold is renewed. */
export function holdRenewalIntervalMs(hold: QueueHold): number {
  return hold.backend === 'sqs'
    ? heartbeatIntervalMs(hold.visibilityTimeoutSeconds)
    : Math.floor(hold.lockDurationMs / 2);
}

export interface FacesBudget {
  /** Rekognition part of the longest indexPhoto attempt (a re-index of a full photo). */
  worstAttemptMs: number;
  /** The smallest FACE_ORPHAN_GRACE_MS for that attempt (2 × it). */
  minOrphanGraceMs: number;
  /** SQS heartbeat or BullMQ lock renewal interval. */
  heartbeatIntervalMs: number;
  /** Configuration problems, for the start-up log. Empty when everything fits. */
  problems: string[];
}

/**
 * Start-up sanity check of the faces consumer's time budget (packages/face README rule 2). Infra's
 * synth check (`facesJobWorstCase`) is the deployment gate; this is the tighter in-process
 * estimate:
 *
 * - FACE_ORPHAN_GRACE_MS must be at least 2 × the longest attempt, or a slow but healthy attempt
 *   misses its record-faces deadline;
 * - WORKER_FACES_MAX_PROCESSING_SECONDS must cover that attempt, or it is cut off;
 * - on SQS, the heartbeat (every visibility timeout / 3, extending up to SQS's 12 h from the
 *   receive) must be able to hold the message for that long. BullMQ renews its lock without a cap.
 */
export function checkFacesBudget(
  face: FaceConfig,
  maxProcessingMs: number,
  hold: QueueHold,
): FacesBudget {
  const maxFacesPerFile = (1 + face.index.tileGrid ** 2) * face.index.maxFaces;
  const worst = indexPhotoWorstCase(face, { previousFaces: maxFacesPerFile });
  const problems: string[] = [];
  if (face.index.orphanGraceMs < worst.minOrphanGraceMs) {
    problems.push(
      `FACE_ORPHAN_GRACE_MS (${face.index.orphanGraceMs}) is shorter than 2 × the longest indexing attempt (${worst.minOrphanGraceMs})`,
    );
  }
  if (maxProcessingMs < worst.rekognitionMs) {
    problems.push(
      `WORKER_FACES_MAX_PROCESSING_SECONDS (${maxProcessingMs / 1000}) is shorter than the longest indexing attempt (${Math.ceil(worst.rekognitionMs / 1000)} s)`,
    );
  }
  if (hold.backend === 'sqs' && maxProcessingMs > SQS_MAX_VISIBILITY_TIMEOUT_SECONDS * 1000) {
    problems.push('WORKER_FACES_MAX_PROCESSING_SECONDS is longer than heartbeats can hold (12 h)');
  }
  const interval = holdRenewalIntervalMs(hold);
  if (interval <= 0) {
    problems.push(
      hold.backend === 'sqs'
        ? 'the faces visibility timeout is too short to heartbeat'
        : 'the faces lock duration is too short to renew',
    );
  }
  return {
    worstAttemptMs: worst.rekognitionMs,
    minOrphanGraceMs: worst.minOrphanGraceMs,
    heartbeatIntervalMs: interval,
    problems,
  };
}
