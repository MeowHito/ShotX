import { z } from 'zod';
import { type Env, parseEnv } from './env';

const usd = z.coerce.number().nonnegative();

// USD list prices used for cost estimates. Update when AWS prices change.
const costEnvSchema = z.object({
  S3_STANDARD_GB_MONTH: usd.default(0.025),
  REKOGNITION_CALL: usd.default(0.001),
  REKOGNITION_FACE_MONTH: usd.default(0.00001),
  CLOUDFRONT_PLAN_MONTH: usd.default(200),
  USD_THB: z.coerce.number().positive().default(33),
});

export interface CostConfig {
  s3StandardGbMonth: number;
  rekognitionCall: number;
  rekognitionFaceMonth: number;
  cloudfrontPlanMonth: number;
  usdThb: number;
}

export function loadCostConfig(env: Env): CostConfig {
  const e = parseEnv(costEnvSchema, env, 'cost');
  return {
    s3StandardGbMonth: e.S3_STANDARD_GB_MONTH,
    rekognitionCall: e.REKOGNITION_CALL,
    rekognitionFaceMonth: e.REKOGNITION_FACE_MONTH,
    cloudfrontPlanMonth: e.CLOUDFRONT_PLAN_MONTH,
    usdThb: e.USD_THB,
  };
}
