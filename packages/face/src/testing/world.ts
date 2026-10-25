import { hash01, mulberry32, shuffle } from './random';

export const POSES = ['front', 'left', 'right'] as const;
export type Pose = (typeof POSES)[number];
export type Rgb = readonly [number, number, number];

export interface WorldPerson {
  id: string;
  color: Rgb;
  /** Similarity lost between this person's selfies and event photos (sunglasses, hat, light). */
  selfieGap: number;
}

export interface Lookalike {
  a: string;
  b: string;
  similarity: number;
}

/** Serializable description of a synthetic population. */
export interface World {
  persons: WorldPerson[];
  lookalikes: Lookalike[];
}

/** One face as seen in one image. */
export interface Observation {
  personId: string;
  pose: Pose;
  /** Face width in pixels, in the image it was seen in. */
  widthPx: number;
  selfie: boolean;
  /** Stable id used to derive deterministic jitter. */
  key: string;
}

const LEVELS = [40, 110, 180, 250] as const;

/** Well-separated saturated colours, one per synthetic person. Greys are left for backgrounds. */
export const PALETTE: Rgb[] = LEVELS.flatMap((r) =>
  LEVELS.flatMap((g) => LEVELS.map((b): Rgb => [r, g, b])),
).filter(([r, g, b]) => !(r === g && g === b));

const POSE_PENALTY: Record<Pose, Record<Pose, number>> = {
  front: { front: 0, left: 5, right: 5 },
  left: { front: 5, left: 0, right: 12 },
  right: { front: 5, left: 12, right: 0 },
};

const MAX_SIMILARITY = 99.99;
const MAX_COLOR_DISTANCE = 60;

/** Face quality from size: 0 at 40 px (Rekognition's detection floor), 1 from 160 px. */
export function faceQuality(widthPx: number): number {
  return Math.min(1, Math.max(0, (widthPx - 40) / 120));
}

/**
 * A synthetic population with a similarity model that behaves like a face matcher: big frontal
 * faces match strongly, small or turned faces weakly, selfies lose a per-person gap, and a few
 * pairs of different people look alike.
 */
export class SyntheticWorld {
  private readonly byId: Map<string, WorldPerson>;
  private readonly lookalikes: Map<string, number>;

  constructor(readonly data: World) {
    this.byId = new Map(data.persons.map((person) => [person.id, person]));
    this.lookalikes = new Map(data.lookalikes.map((l) => [pairKey(l.a, l.b), l.similarity]));
  }

  static create(options: { volunteers: number; bystanders: number; seed: number }): SyntheticWorld {
    const total = options.volunteers + options.bystanders;
    if (total > PALETTE.length) {
      throw new RangeError(`A synthetic world holds at most ${PALETTE.length} persons`);
    }
    const random = mulberry32(options.seed);
    const colors = shuffle([...PALETTE], random);
    const persons = colors.slice(0, total).map(
      (color, i): WorldPerson => ({
        id: i < options.volunteers ? `v${pad(i + 1)}` : `b${pad(i - options.volunteers + 1)}`,
        color,
        selfieGap: random() < 0.3 ? 4 + random() * 6 : random() * 3,
      }),
    );
    const order = shuffle([...persons], random);
    const lookalikes: Lookalike[] = [];
    for (let i = 0; i + 1 < order.length && lookalikes.length < Math.round(total * 0.15); i += 2) {
      lookalikes.push({ a: order[i]!.id, b: order[i + 1]!.id, similarity: 80 + random() * 8 });
    }
    return new SyntheticWorld({ persons, lookalikes });
  }

  get persons(): readonly WorldPerson[] {
    return this.data.persons;
  }

  person(id: string): WorldPerson {
    const person = this.byId.get(id);
    if (!person) throw new Error(`Unknown synthetic person ${id}`);
    return person;
  }

  /** The person whose colour is closest to `rgb`, if any is close enough. */
  personByColor(rgb: Rgb): WorldPerson | undefined {
    let best: WorldPerson | undefined;
    let bestDistance = MAX_COLOR_DISTANCE;
    for (const person of this.data.persons) {
      const distance = Math.hypot(
        person.color[0] - rgb[0],
        person.color[1] - rgb[1],
        person.color[2] - rgb[2],
      );
      if (distance < bestDistance) {
        best = person;
        bestDistance = distance;
      }
    }
    return best;
  }

  similarity(a: Observation, b: Observation): number {
    const quality = Math.min(faceQuality(a.widthPx), faceQuality(b.widthPx));
    const pose = POSE_PENALTY[a.pose][b.pose];
    const key = pairKey(a.key, b.key);
    const jitter = (hash01(key) - 0.5) * 3;
    if (a.personId === b.personId) {
      const gap = a.selfie || b.selfie ? this.person(a.personId).selfieGap : 0;
      return clampSimilarity(80 + 19.5 * quality - pose - gap + jitter);
    }
    const lookalike = this.lookalikes.get(pairKey(a.personId, b.personId));
    if (lookalike !== undefined) {
      return clampSimilarity(lookalike + 4 * (1 - quality) - pose / 2 + jitter);
    }
    return 20 + 30 * hash01(`${key}#`);
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function clampSimilarity(value: number): number {
  return Math.min(MAX_SIMILARITY, Math.max(0, value));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
