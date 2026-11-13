import { z } from 'zod';
import { type Env, parseEnv } from './env';

const usd = z.coerce.number().nonnegative();

// List prices used for cost estimates. Update when provider prices change.
const costEnvSchema = z.object({
  S3_STANDARD_GB_MONTH: usd.default(0.025),
  REKOGNITION_CALL: usd.default(0.001),
  REKOGNITION_FACE_MONTH: usd.default(0.00001),
  CLOUDFRONT_PLAN_MONTH: usd.default(200),
  /** Cloudflare R2 Standard storage, USD per GB-month (1 GB = 2^30 bytes on R2's bill). */
  R2_STORAGE_GB_MONTH: usd.default(0.015),
  /** GB-months of R2 storage Cloudflare gives free every month. */
  R2_FREE_STORAGE_GB: usd.default(10),
  /**
   * What the VPS costs per month in THB (Hostinger bills in THB). KVM 8: 36,696 THB per 2 years
   * = 1,529 THB a month. 0 hides the VPS cost.
   */
  VPS_MONTH_THB: z.coerce.number().nonnegative().default(1529),
  USD_THB: z.coerce.number().positive().default(33),
});

export interface CostConfig {
  s3StandardGbMonth: number;
  rekognitionCall: number;
  rekognitionFaceMonth: number;
  cloudfrontPlanMonth: number;
  /** R2_STORAGE_GB_MONTH (USD). */
  r2StorageGbMonth: number;
  /** R2_FREE_STORAGE_GB. */
  r2FreeStorageGb: number;
  /** VPS_MONTH_THB. */
  vpsMonthThb: number;
  usdThb: number;
}

export function loadCostConfig(env: Env): CostConfig {
  const e = parseEnv(costEnvSchema, env, 'cost');
  return {
    s3StandardGbMonth: e.S3_STANDARD_GB_MONTH,
    rekognitionCall: e.REKOGNITION_CALL,
    rekognitionFaceMonth: e.REKOGNITION_FACE_MONTH,
    cloudfrontPlanMonth: e.CLOUDFRONT_PLAN_MONTH,
    r2StorageGbMonth: e.R2_STORAGE_GB_MONTH,
    r2FreeStorageGb: e.R2_FREE_STORAGE_GB,
    vpsMonthThb: e.VPS_MONTH_THB,
    usdThb: e.USD_THB,
  };
}

/** Bytes in one GB of R2's storage bill. */
const R2_GB = 1024 ** 3;

/**
 * Monthly R2 storage estimate in USD if the bucket stays at `bytes` all month: storage above the
 * free GB-months times the GB-month price. Operations (Class A/B) aren't counted; egress is free.
 */
export function estimateR2StorageUsdMonth(bytes: number, cost: CostConfig): number {
  const billableGb = Math.max(0, bytes / R2_GB - cost.r2FreeStorageGb);
  return billableGb * cost.r2StorageGbMonth;
}
