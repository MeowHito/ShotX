import { Inject, Injectable } from '@nestjs/common';
import type { DriveFile as DriveFileRow, Folder } from '@shotx/db';
import { type DriveFile, type DriveFolder, type MediaKind, UPLOAD_FILE_TYPES } from '@shotx/shared';
import type { ApiConfig } from '../config';
import { API_CONFIG, CLOCK, type Clock, MEDIA_URL_SIGNER, type MediaUrlSigner } from '../tokens';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

/** The media kind of a stored MIME type (always an allowlist entry: init stores the canonical one). */
export function mediaKindOf(mime: string): MediaKind {
  return UPLOAD_FILE_TYPES.find((t) => t.mime === mime)?.kind ?? 'image';
}

export function toDriveFolder(row: Folder): DriveFolder {
  return {
    kind: 'folder',
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    createdAt: iso(row.createdAt),
    deletedAt: isoOrNull(row.deletedAt),
    faceIndexEnabled: row.faceIndexEnabled,
    faceIndexExpiresAt: isoOrNull(row.faceIndexExpiresAt),
  };
}

/** The file fields of the API, without signed URLs. */
export function toDriveFileBase(row: DriveFileRow): DriveFile {
  return {
    kind: 'file',
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    mime: row.mime,
    mediaKind: mediaKindOf(row.mime),
    sizeBytes: row.sizeBytes,
    status: row.status,
    width: row.width,
    height: row.height,
    takenAt: isoOrNull(row.takenAt),
    faceCount: row.faceCount,
    createdAt: iso(row.createdAt),
    deletedAt: isoOrNull(row.deletedAt),
  };
}

/**
 * Builds API files with CloudFront signed URLs of the derivatives that exist (view TTL from the
 * share config). Signed URLs only, never S3 URLs. These are the owner's own drive views; they
 * are not share activity, so no activity_event is written (activity_events.share_id is required).
 */
@Injectable()
export class DriveFileMapper {
  constructor(
    @Inject(MEDIA_URL_SIGNER) private readonly signer: MediaUrlSigner,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  toDriveFile(row: DriveFileRow): DriveFile {
    const file = toDriveFileBase(row);
    if (row.purgeRequestedAt !== null) return file;
    const expiresAt = new Date(
      this.clock.now().getTime() + this.config.share.signedUrlTtlSeconds.view * 1000,
    );
    if (row.thumbKey !== null) file.thumbUrl = this.signer.sign(row.thumbKey, expiresAt);
    if (row.previewKey !== null) file.previewUrl = this.signer.sign(row.previewKey, expiresAt);
    if (row.posterKey !== null) file.posterUrl = this.signer.sign(row.posterKey, expiresAt);
    return file;
  }
}
