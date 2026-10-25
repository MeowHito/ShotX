import { SyntheticWorld } from '@shotx/face/testing';
import { describe, expect, it } from 'vitest';
import { planScenes } from './synth';

const options = {
  photos: 40,
  volunteers: 10,
  absent: 2,
  bystanders: 10,
  seed: 5,
  width: 4000,
  height: 2667,
};
const world = SyntheticWorld.create({ volunteers: 10, bystanders: 10, seed: 5 });

describe('planScenes', () => {
  const scenes = planScenes(world, options);

  it('is deterministic for a seed', () => {
    expect(planScenes(world, options)).toEqual(scenes);
    expect(planScenes(world, { ...options, seed: 6 })).not.toEqual(scenes);
  });

  it('places distinct, non-overlapping faces inside the frame', () => {
    for (const scene of scenes) {
      const ids = scene.faces.map((f) => f.personId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const [i, a] of scene.faces.entries()) {
        expect(a.left).toBeGreaterThanOrEqual(0);
        expect(a.top).toBeGreaterThanOrEqual(0);
        expect(a.left + a.size).toBeLessThanOrEqual(scene.width);
        expect(a.top + a.size).toBeLessThanOrEqual(scene.height);
        for (const b of scene.faces.slice(i + 1)) {
          const apart =
            a.left + a.size < b.left ||
            b.left + b.size < a.left ||
            a.top + a.size < b.top ||
            b.top + b.size < a.top;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it('keeps absent volunteers out of every photo', () => {
    const placed = new Set(scenes.flatMap((s) => s.faces.map((f) => f.personId)));
    expect(placed.has('v01')).toBe(false);
    expect(placed.has('v02')).toBe(false);
    expect(placed.has('v03')).toBe(true);
  });
});
