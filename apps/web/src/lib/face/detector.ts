import type { ClientFaceConfig } from './config';
import type { FaceBox } from './quality-gate';

/** What the quality gate needs from a face detector. */
export interface FaceDetectorLike {
  /** Faces in the image, in its pixel coordinates. */
  detect(image: CanvasImageSource): FaceBox[];
}

export type DetectorLoader = () => Promise<FaceDetectorLike | null>;

/**
 * Lazily loads the MediaPipe Face Detector (BlazeFace short range) on first use, from
 * self-hosted assets only: the wasm files under `detector.wasmBasePath` and the model at
 * `detector.modelPath`, both same-origin paths (validated in clientFaceConfig). The module itself
 * is a separate chunk, so pages that never scan never download it.
 *
 * Resolves to null when anything fails (old browser, asset missing, CSP): the gate then skips the
 * face checks and the API's NO_FACE_DETECTED remains the backstop.
 */
export function createMediaPipeDetectorLoader(
  config: Pick<ClientFaceConfig, 'detector' | 'gate'>,
): DetectorLoader {
  let loading: Promise<FaceDetectorLike | null> | null = null;
  return () => {
    loading ??= (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(config.detector.wasmBasePath);
        const detector = await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: config.detector.modelPath, delegate: 'CPU' },
          runningMode: 'IMAGE',
          minDetectionConfidence: config.gate.minScore,
        });
        return {
          detect(image) {
            const result = detector.detect(image as Parameters<typeof detector.detect>[0]);
            return result.detections.map((d) => ({
              x: d.boundingBox?.originX ?? 0,
              y: d.boundingBox?.originY ?? 0,
              width: d.boundingBox?.width ?? 0,
              height: d.boundingBox?.height ?? 0,
              score: d.categories[0]?.score ?? 0,
              keypoints: d.keypoints.map((k) => ({ x: k.x, y: k.y })),
            }));
          },
        } satisfies FaceDetectorLike;
      } catch {
        return null;
      }
    })();
    return loading;
  };
}
