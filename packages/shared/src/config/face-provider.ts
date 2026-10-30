/**
 * The face recognition backend behind FaceProvider (ADR 0009): `self-hosted` runs ONNX models in
 * the api and worker processes and keeps vectors in Postgres (pgvector); `rekognition` is Amazon
 * Rekognition, selectable until Phase 0 is done.
 */
export const FACE_PROVIDERS = ['self-hosted', 'rekognition'] as const;
export type FaceProviderName = (typeof FACE_PROVIDERS)[number];
