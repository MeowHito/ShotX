import { faceCollectionId } from '@shotx/face';
import {
  type FakeFaceProvider,
  type Pose,
  renderScene,
  type Scene,
  selfieScene,
  SyntheticWorld,
} from '@shotx/face/testing';
import { faces } from '@shotx/db';
import type { Db } from '../db/db';

/**
 * A fixed synthetic population for API tests: no selfie gap and no lookalikes, so similarities are
 * deterministic enough to bucket (FakeFaceProvider scores big frontal faces ~99.5 for the same
 * person, ~90 for a 100 px face, and 20–50 for anyone else).
 */
export function testWorld(): SyntheticWorld {
  return new SyntheticWorld({
    persons: [
      { id: 'alice', color: [250, 40, 40], selfieGap: 0 },
      { id: 'bob', color: [40, 40, 250], selfieGap: 0 },
      { id: 'carol', color: [40, 250, 40], selfieGap: 0 },
    ],
    lookalikes: [],
  });
}

let seed = 1;

/** A phone selfie of `personId` (JPEG). */
export function selfie(
  world: SyntheticWorld,
  personId: string,
  pose: Pose = 'front',
): Promise<Buffer> {
  return renderScene(world, selfieScene(personId, pose), seed++);
}

/** A JPEG with no face at all. */
export function emptyPhoto(world: SyntheticWorld): Promise<Buffer> {
  return renderScene(world, { width: 640, height: 480, faces: [] }, seed++);
}

/** An event photo with the given faces side by side (sizes in px; 200 = strong, 100 = maybe). */
export function eventPhoto(
  world: SyntheticWorld,
  people: readonly { personId: string; size: number; pose?: Pose }[],
): Promise<Buffer> {
  const scene: Scene = { width: 1200, height: 800, faces: [] };
  let left = 40;
  for (const p of people) {
    scene.faces.push({
      personId: p.personId,
      pose: p.pose ?? 'front',
      left,
      top: 200,
      size: p.size,
    });
    left += p.size + 60;
  }
  return renderScene(world, scene, seed++);
}

/**
 * Indexes `photo` as file `fileId` of `ownerId` in the fake collection `pg-{ownerId}` and records
 * the faces rows, as the worker does. Returns the Rekognition face ids.
 */
export async function indexPhoto(
  db: Db,
  provider: FakeFaceProvider,
  ownerId: string,
  fileId: string,
  photo: Buffer,
): Promise<string[]> {
  const collectionId = faceCollectionId(ownerId);
  await provider.createCollection(collectionId);
  const result = await provider.indexFaces({
    collectionId,
    image: { bytes: photo },
    externalImageId: fileId,
    maxFaces: 100,
    qualityFilter: 'LOW',
  });
  if (result.faces.length > 0) {
    await db.insert(faces).values(
      result.faces.map((f) => ({
        fileId,
        ownerId,
        rekognitionFaceId: f.faceId,
        bbox: f.bbox,
        confidence: f.confidence,
      })),
    );
  }
  return result.faces.map((f) => f.faceId);
}
