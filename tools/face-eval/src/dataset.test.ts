import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatasetError, describeDataset, loadDataset, readSelfies } from './dataset';

// Fixture files are a few placeholder bytes: the loader lists files and never decodes them.
let dir: string;

async function put(path: string, content: string | Uint8Array = 'x'): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
}

async function labels(value: unknown): Promise<void> {
  await put('labels.json', JSON.stringify(value));
}

async function validDataset(): Promise<void> {
  await put('photos/start/IMG_0002.jpg');
  await put('photos/start/IMG_0001.JPG');
  await put('photos/finish/b.webp');
  await put('photos/notes.txt');
  await put('photos/.hidden/c.jpg');
  await put('selfies/v01/2-left.jpg', 'left');
  await put('selfies/v01/1-front.jpg', 'front');
  await put('selfies/v02/1-front.png');
  await labels({
    version: 1,
    event: 'Test run',
    persons: { v02: [], v01: ['start/IMG_0001.JPG', 'finish/b.webp'] },
  });
}

async function problems(): Promise<string[]> {
  const error: unknown = await loadDataset(dir).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DatasetError);
  return (error as DatasetError).problems;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'face-eval-dataset-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadDataset', () => {
  it('loads photos, labels and selfies in a stable order', async () => {
    await validDataset();
    const dataset = await loadDataset(dir);
    expect(dataset.event).toBe('Test run');
    expect(dataset.synthetic).toBeUndefined();
    expect(dataset.photos).toEqual([
      { id: 'p1', path: 'finish/b.webp' },
      { id: 'p2', path: 'start/IMG_0001.JPG' },
      { id: 'p3', path: 'start/IMG_0002.jpg' },
    ]);
    expect(dataset.persons.map((p) => [p.id, [...p.positives], p.selfies])).toEqual([
      ['v01', ['p2', 'p1'], ['selfies/v01/1-front.jpg', 'selfies/v01/2-left.jpg']],
      ['v02', [], ['selfies/v02/1-front.png']],
    ]);
    expect(describeDataset(dataset)).toEqual({
      event: 'Test run',
      synthetic: false,
      photos: 3,
      photosWithoutVolunteers: 1,
      persons: 2,
      personsAbsent: 1,
      appearances: 2,
      selfies: 3,
    });
  });

  it('reads only the requested number of selfies, in order', async () => {
    await validDataset();
    const dataset = await loadDataset(dir);
    const selfies = await readSelfies(dataset, dataset.persons[0]!, 1);
    expect(selfies.map((b) => b.toString())).toEqual(['front']);
  });

  it('reports every labelling problem at once', async () => {
    await validDataset();
    await put('selfies/v09/1-front.jpg');
    await labels({
      version: 1,
      persons: {
        v01: ['start/IMG_0001.JPG', 'start/IMG_0001.JPG', 'missing.jpg'],
        v03: ['finish/b.webp'],
      },
    });
    expect(await problems()).toEqual([
      'labels.json: v01: start/IMG_0001.JPG is listed twice',
      'labels.json: v01: missing.jpg is not an image in photos/',
      'selfies/v03/ has no selfies',
      'selfies/v02/ has no entry in labels.json (its ground truth is unknown)',
      'selfies/v09/ has no entry in labels.json (its ground truth is unknown)',
    ]);
  });

  it('rejects malformed labels', async () => {
    await validDataset();
    for (const bad of [
      { version: 2, persons: { v01: [] } },
      { version: 1, persons: {} },
      { version: 1, persons: { 'Somchai Jaidee': [] } },
      { version: 1, persons: { v01: ['../outside.jpg'] } },
      { version: 1, persons: { v01: ['/etc/x.jpg'] } },
      { version: 1, persons: { v01: [] }, names: { v01: 'Somchai' } },
    ]) {
      await labels(bad);
      expect((await problems()).some((p) => p.startsWith('labels.json:'))).toBe(true);
    }
  });

  it('requires photos and caps selfies per person', async () => {
    await labels({ version: 1, persons: { v01: [] } });
    for (const n of [1, 2, 3, 4, 5, 6]) await put(`selfies/v01/${n}.jpg`);
    expect(await problems()).toEqual([
      'photos/ has no JPEG, PNG or WebP files',
      'selfies/v01/ has 6 selfies; at most 5',
    ]);
  });

  it('validates synthetic.json when present', async () => {
    await validDataset();
    await put('synthetic.json', JSON.stringify({ version: 1, seed: 'x' }));
    expect((await problems())[0]).toMatch(/^synthetic\.json: /);
  });
});
