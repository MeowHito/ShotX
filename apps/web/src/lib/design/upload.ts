import {
  DESIGN_ROUTES,
  type DesignAssetView,
  designAssetFileType,
  ErrorCode,
  ERROR_HTTP_STATUS,
} from '@shotx/shared';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { ClientError } from '@/lib/errors/messages';

/**
 * Uploads one design image (ADR 0013): POST /designs/assets reserves it and presigns one PUT,
 * the browser PUTs the bytes straight to the bucket (never through the API), POST
 * /designs/assets/:id/complete hands it to the worker, then GET /designs/assets/:id is polled
 * until the worker made it `ready` (or `failed`).
 */

export interface DesignUploadDeps {
  api: ApiClient;
  /** fetch for the presigned PUT (tests: the fake bucket). */
  putObject?: typeof fetch;
  /** Wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** Polls before giving up (client.designAssetTimeout). */
  maxPolls?: number;
  /** DESIGN_ASSET_MAX_BYTES (limits.assetMaxBytes): larger files are refused before any call. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Called with the asset after `complete` (status processing) and on each poll. */
  onProgress?: (asset: DesignAssetView) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Refuses what the API would refuse anyway, with the same codes (one message mapping). */
export function precheckDesignImage(file: File, maxBytes: number): void {
  if (designAssetFileType(file.name, file.type) === null) {
    const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? null;
    throw new ApiError(
      ERROR_HTTP_STATUS.UNSUPPORTED_FILE_TYPE,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      'unsupported',
      { extension: ext, hint: ext === 'heic' || ext === 'heif' ? 'heic' : null },
    );
  }
  if (file.size === 0) throw new ClientError('client.emptyFile');
  if (file.size > maxBytes) {
    throw new ApiError(ERROR_HTTP_STATUS.FILE_TOO_LARGE, ErrorCode.FILE_TOO_LARGE, 'too large', {
      maxBytes,
    });
  }
}

export async function uploadDesignImage(
  file: File,
  deps: DesignUploadDeps,
): Promise<DesignAssetView> {
  precheckDesignImage(file, deps.maxBytes);
  const { api, signal } = deps;
  const put = deps.putObject ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? defaultSleep;
  const interval = deps.pollIntervalMs ?? 1000;
  const maxPolls = deps.maxPolls ?? 120;

  const created = await api.call(DESIGN_ROUTES.createAsset, {
    body: { fileName: file.name, mime: file.type, sizeBytes: file.size },
    signal,
  });
  let response: Response;
  try {
    response = await put(created.uploadUrl, {
      method: 'PUT',
      headers: created.headers,
      body: file,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ClientError('client.storageUpload');
  }
  if (!response.ok) throw new ClientError('client.storageUpload');

  let asset = await api.call(DESIGN_ROUTES.completeAsset, {
    params: { id: created.assetId },
    signal,
  });
  deps.onProgress?.(asset);
  for (let polls = 0; asset.status !== 'ready'; polls++) {
    if (asset.status === 'failed') throw new ClientError('client.designAssetFailed');
    if (polls >= maxPolls) throw new ClientError('client.designAssetTimeout');
    await sleep(interval);
    asset = await api.call(DESIGN_ROUTES.getAsset, { params: { id: created.assetId }, signal });
    deps.onProgress?.(asset);
  }
  return asset;
}
