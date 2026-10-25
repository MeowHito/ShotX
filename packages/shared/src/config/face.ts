import { z } from 'zod';
import { type Env, parseEnv } from './env';

export const QUALITY_FILTERS = ['NONE', 'AUTO', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type QualityFilter = (typeof QUALITY_FILTERS)[number];

const percent = z.coerce.number().min(0).max(100);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const ratio = z.coerce.number().min(0).max(1);

// Defaults are the starting values from the platform spec. The face PoC decides the real ones.
const faceEnvSchema = z
  .object({
    FACE_STRONG: percent.default(95),
    FACE_MAYBE: percent.default(85),
    FACE_MAX_SELFIES: int(1, 5).default(3),
    FACE_EXPANSION_SEEDS: int(0, 10).default(2),
    FACE_SEARCH_MAX_FACES: int(1, 4096).default(1000),
    FACE_SEARCH_QUALITY_FILTER: z.enum(QUALITY_FILTERS).default('AUTO'),
    FACE_SELFIE_LONG_EDGE: int(320, 4096).default(1280),
    FACE_SELFIE_JPEG_QUALITY: int(50, 100).default(90),
    FACE_INDEX_LONG_EDGE: int(640, 8192).default(3500),
    FACE_INDEX_JPEG_QUALITY: int(50, 100).default(90),
    FACE_INDEX_MAX_BYTES: int(1, 15 * 1024 * 1024).default(15 * 1024 * 1024),
    FACE_INDEX_MAX_FACES: int(1, 100).default(100),
    FACE_INDEX_QUALITY_FILTER: z.enum(QUALITY_FILTERS).default('LOW'),
    FACE_TILE_GRID: int(1, 4).default(2),
    FACE_TILE_OVERLAP: z.coerce.number().min(0).max(0.5).default(0.15),
    FACE_SMALL_FACE_RATIO: ratio.default(0.02),
    FACE_DEDUPE_IOU: ratio.default(0.5),
    FACE_REKOGNITION_TPS: z.coerce.number().positive().default(5),
    FACE_REKOGNITION_MAX_ATTEMPTS: int(1, 20).default(8),
    FACE_REKOGNITION_RETRY_BASE_MS: int(1, 60_000).default(200),
    FACE_REKOGNITION_RETRY_MAX_MS: int(1, 300_000).default(10_000),
    AWS_REGION: z.string().min(1).default('ap-southeast-1'),
  })
  .refine((env) => env.FACE_STRONG >= env.FACE_MAYBE, {
    error: 'FACE_STRONG must be greater than or equal to FACE_MAYBE',
  });

export interface FaceThresholds {
  /** Matches at or above this similarity are shown as "ใช่คุณ" and may seed expansion. */
  strong: number;
  /** Matches at or above this similarity are shown as "อาจจะเป็นคุณ". */
  maybe: number;
}

export interface FaceConfig {
  thresholds: FaceThresholds;
  search: {
    maxSelfies: number;
    expansionSeeds: number;
    maxFaces: number;
    qualityFilter: QualityFilter;
  };
  selfie: { longEdge: number; jpegQuality: number };
  index: {
    longEdge: number;
    jpegQuality: number;
    maxBytes: number;
    maxFaces: number;
    qualityFilter: QualityFilter;
    tileGrid: number;
    tileOverlap: number;
    smallFaceRatio: number;
    dedupeIou: number;
  };
  rekognition: {
    region: string;
    tps: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
}

export function loadFaceConfig(env: Env): FaceConfig {
  const e = parseEnv(faceEnvSchema, env, 'face');
  return {
    thresholds: { strong: e.FACE_STRONG, maybe: e.FACE_MAYBE },
    search: {
      maxSelfies: e.FACE_MAX_SELFIES,
      expansionSeeds: e.FACE_EXPANSION_SEEDS,
      maxFaces: e.FACE_SEARCH_MAX_FACES,
      qualityFilter: e.FACE_SEARCH_QUALITY_FILTER,
    },
    selfie: { longEdge: e.FACE_SELFIE_LONG_EDGE, jpegQuality: e.FACE_SELFIE_JPEG_QUALITY },
    index: {
      longEdge: e.FACE_INDEX_LONG_EDGE,
      jpegQuality: e.FACE_INDEX_JPEG_QUALITY,
      maxBytes: e.FACE_INDEX_MAX_BYTES,
      maxFaces: e.FACE_INDEX_MAX_FACES,
      qualityFilter: e.FACE_INDEX_QUALITY_FILTER,
      tileGrid: e.FACE_TILE_GRID,
      tileOverlap: e.FACE_TILE_OVERLAP,
      smallFaceRatio: e.FACE_SMALL_FACE_RATIO,
      dedupeIou: e.FACE_DEDUPE_IOU,
    },
    rekognition: {
      region: e.AWS_REGION,
      tps: e.FACE_REKOGNITION_TPS,
      maxAttempts: e.FACE_REKOGNITION_MAX_ATTEMPTS,
      retryBaseMs: e.FACE_REKOGNITION_RETRY_BASE_MS,
      retryMaxMs: e.FACE_REKOGNITION_RETRY_MAX_MS,
    },
  };
}
