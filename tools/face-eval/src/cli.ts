import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { TILING_MODES, type TilingMode } from '@shotx/face';
import { loadCostConfig, loadFaceConfig, QUALITY_FILTERS, type QualityFilter } from '@shotx/shared';
import { format, resolveConfig } from 'prettier';
import { analyze, type CostAssumptions, type Targets } from './analysis';
import { describeDataset, loadDataset } from './dataset';
import { evaluate, type IndexOption, type SearchOption } from './evaluate';
import { analyzeFailures } from './failures';
import { parseGrid, scoreScans, summarize } from './metrics';
import { assertNotCommittable, DEFAULT_SYNTHETIC_DIR, PACKAGE_DIR, RUNS_DIR } from './paths';
import { AWS_ACKNOWLEDGEMENT, assertProviderAllowed, createProvider } from './providers';
import { renderReport } from './report';
import { synthesize } from './synth';

const USAGE = `face-eval: measure face search accuracy before building UI on it.

Usage:
  pnpm face-eval synth [options]      Generate a synthetic dataset (git-ignored data/ folder)
  pnpm face-eval validate [options]   Check a dataset's layout and labels; prints counts only
  pnpm face-eval run [options]        Evaluate a dataset and write a report

synth:
  --out <dir>              default ${relativeToRepo(DEFAULT_SYNTHETIC_DIR)}
  --photos <n>             default 120
  --volunteers <n>         default 24 (persons with selfies and labels)
  --absent <n>             default 2 (volunteers who are in no photo)
  --bystanders <n>         default 36 (volunteers + bystanders ≤ 60)
  --seed <n>               default 1
  --width <px> --height <px>  default 4000 × 2667
  --force                  replace a folder synth created before

validate / run:
  --dataset <dir>          default ${relativeToRepo(DEFAULT_SYNTHETIC_DIR)}

run:
  --provider fake|rekognition   default fake (synthetic datasets only)
  --${AWS_ACKNOWLEDGEMENT}   required with --provider rekognition (billed AWS calls)
  --temp-bucket <bucket>        rekognition only: pass index images through S3 tmp/index/
  --long-edges <list>           default 1600,2400,FACE_INDEX_LONG_EDGE
  --quality-filters <list>      default LOW,MEDIUM
  --tiling <list>               default never,signal,always
  --expansion-seeds <list>      default 0,FACE_EXPANSION_SEEDS
  --selfies <list>              default 1,FACE_MAX_SELFIES
  --strong <from:to:step|list>  FACE_STRONG sweep, default 80:99:1
  --maybe <from:to:step|list>   FACE_MAYBE sweep, default 70:95:1
  --strong-precision <0-1>      default 0.98
  --overall-precision <0-1>     default 0.90
  --min-recall <0-1>            default 0.80 (go criterion)
  --max-zero-result <0-1>       default 0.10 (go criterion)
  --recall-tolerance <0-1>      default 0.01
  --scans-per-1000-photos <n>   default 100
  --retention-months <n>        default 3
  --concurrency <n>             default 4
  --runs-dir <dir>              default ${relativeToRepo(RUNS_DIR)}
  --report <file>               also write the report here (e.g. tools/face-eval/reports/<name>.md)
  --keep-collections            don't delete the evaluation collections afterwards
`;

function relativeToRepo(path: string): string {
  return path.replace(`${resolve(PACKAGE_DIR, '..', '..')}/`, '');
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function number(value: string | undefined, fallback: number, name: string, min = 0): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} must be a number ≥ ${min}`);
  return n;
}

function ratio(value: string | undefined, fallback: number, name: string): number {
  const n = number(value, fallback, name);
  if (n > 1) throw new Error(`--${name} must be between 0 and 1`);
  return n;
}

function list<T extends string>(
  value: string | undefined,
  fallback: T[],
  allowed: readonly T[],
  name: string,
  normalize: (item: string) => string,
): T[] {
  if (value === undefined) return fallback;
  const items = value.split(',').map((v) => normalize(v.trim()));
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw new Error(`--${name}: "${item}" is not one of ${allowed.join(', ')}`);
    }
  }
  return [...new Set(items)] as T[];
}

function integers(
  value: string | undefined,
  fallback: number[],
  name: string,
  min: number,
): number[] {
  const values = value === undefined ? fallback : parseGrid(value);
  if (values.some((v) => !Number.isInteger(v) || v < min)) {
    throw new Error(`--${name} must list integers ≥ ${min}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Short HEAD commit, marked "-dirty" when the face pipeline or the harness has local changes. */
function gitCommit(): string | undefined {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: PACKAGE_DIR, stdio: 'pipe' }).toString().trim();
  try {
    const dirty = git(
      'status',
      '--porcelain',
      '--',
      '../../packages/face',
      '../../packages/shared',
      'src',
    );
    return `${git('rev-parse', '--short', 'HEAD')}${dirty ? '-dirty' : ''}`;
  } catch {
    return undefined;
  }
}

async function writeMarkdown(path: string, markdown: string): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await format(markdown, { ...options, filepath: path }));
}

async function synthCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      out: { type: 'string' },
      photos: { type: 'string' },
      volunteers: { type: 'string' },
      absent: { type: 'string' },
      bystanders: { type: 'string' },
      seed: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const out = resolve(values.out ?? DEFAULT_SYNTHETIC_DIR);
  assertNotCommittable(out, 'Output folder');
  const started = Date.now();
  const result = await synthesize(
    {
      out,
      photos: number(values.photos, 120, 'photos', 1),
      volunteers: number(values.volunteers, 24, 'volunteers', 1),
      absent: number(values.absent, 2, 'absent'),
      bystanders: number(values.bystanders, 36, 'bystanders'),
      seed: number(values.seed, 1, 'seed'),
      width: number(values.width, 4000, 'width', 640),
      height: number(values.height, 2667, 'height', 480),
    },
    { force: values.force, log },
  );
  log(
    `Wrote ${result.photos} photos and ${result.volunteers} volunteers' selfies to ${result.dir} ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}

async function validateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, strict: true, options: { dataset: { type: 'string' } } });
  const dir = resolve(values.dataset ?? DEFAULT_SYNTHETIC_DIR);
  assertNotCommittable(dir, 'Dataset');
  const dataset = await loadDataset(dir);
  process.stdout.write(`${JSON.stringify(describeDataset(dataset), null, 2)}\n`);
}

async function runCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      dataset: { type: 'string' },
      provider: { type: 'string', default: 'fake' },
      [AWS_ACKNOWLEDGEMENT]: { type: 'boolean', default: false },
      'temp-bucket': { type: 'string' },
      'long-edges': { type: 'string' },
      'quality-filters': { type: 'string' },
      tiling: { type: 'string' },
      'expansion-seeds': { type: 'string' },
      selfies: { type: 'string' },
      strong: { type: 'string' },
      maybe: { type: 'string' },
      'strong-precision': { type: 'string' },
      'overall-precision': { type: 'string' },
      'min-recall': { type: 'string' },
      'max-zero-result': { type: 'string' },
      'recall-tolerance': { type: 'string' },
      'scans-per-1000-photos': { type: 'string' },
      'retention-months': { type: 'string' },
      concurrency: { type: 'string' },
      'runs-dir': { type: 'string' },
      report: { type: 'string' },
      'keep-collections': { type: 'boolean', default: false },
    },
  });
  // Checked before anything else, so a missing flag never gets as far as building an AWS client.
  assertProviderAllowed(values.provider, values[AWS_ACKNOWLEDGEMENT] === true);

  const config = loadFaceConfig(process.env);
  const cost = loadCostConfig(process.env);
  const datasetDir = resolve(values.dataset ?? DEFAULT_SYNTHETIC_DIR);
  assertNotCommittable(datasetDir, 'Dataset');
  const runsDir = resolve(values['runs-dir'] ?? RUNS_DIR);
  assertNotCommittable(runsDir, 'Runs folder');
  const dataset = await loadDataset(datasetDir);
  const summary = describeDataset(dataset);
  log(
    `Dataset: ${summary.photos} photos, ${summary.persons} volunteers, ` +
      `${summary.appearances} appearances${summary.synthetic ? ' (synthetic)' : ''}`,
  );

  const longEdges = integers(
    values['long-edges'],
    [1600, 2400, config.index.longEdge],
    'long-edges',
    320,
  );
  const filters = list<QualityFilter>(
    values['quality-filters'],
    ['LOW', 'MEDIUM'],
    QUALITY_FILTERS,
    'quality-filters',
    (v) => v.toUpperCase(),
  );
  const tilings = list<TilingMode>(values.tiling, [...TILING_MODES], TILING_MODES, 'tiling', (v) =>
    v.toLowerCase(),
  );
  const seeds = integers(
    values['expansion-seeds'],
    [0, config.search.expansionSeeds],
    'expansion-seeds',
    0,
  );
  const selfies = integers(values.selfies, [1, config.search.maxSelfies], 'selfies', 1);
  const strongGrid = [
    ...new Set([...parseGrid(values.strong ?? '80:99:1'), config.thresholds.strong]),
  ].sort((a, b) => a - b);
  const maybeGrid = [
    ...new Set([...parseGrid(values.maybe ?? '70:95:1'), config.thresholds.maybe]),
  ].sort((a, b) => a - b);
  const indexOptions: IndexOption[] = longEdges.flatMap((longEdge) =>
    filters.flatMap((qualityFilter) =>
      tilings.map((tiling) => ({ longEdge, qualityFilter, tiling })),
    ),
  );
  const searchOptions: SearchOption[] = seeds.flatMap((expansionSeeds) =>
    selfies.map((count) => ({ selfies: count, expansionSeeds })),
  );
  const targets: Targets = {
    strongPrecision: ratio(values['strong-precision'], 0.98, 'strong-precision'),
    overallPrecision: ratio(values['overall-precision'], 0.9, 'overall-precision'),
    minRecall: ratio(values['min-recall'], 0.8, 'min-recall'),
    maxZeroResult: ratio(values['max-zero-result'], 0.1, 'max-zero-result'),
    recallTolerance: ratio(values['recall-tolerance'], 0.01, 'recall-tolerance'),
  };
  const assumptions: CostAssumptions = {
    cost,
    scansPer1000Photos: number(values['scans-per-1000-photos'], 100, 'scans-per-1000-photos'),
    retentionMonths: number(values['retention-months'], 3, 'retention-months'),
  };

  const setup = createProvider({
    name: values.provider,
    acknowledged: values[AWS_ACKNOWLEDGEMENT] === true,
    dataset,
    config,
    tempBucket: values['temp-bucket'],
  });
  const tiles = config.index.tileGrid ** 2;
  const upperBound =
    indexOptions.length * summary.photos * (1 + tiles + 1) +
    indexOptions.length * summary.persons * (Math.max(...selfies) + Math.max(...seeds));
  log(
    `Provider: ${setup.description}. ${indexOptions.length} index options × ${searchOptions.length} search options; ` +
      `at most ~${upperBound.toLocaleString('en-US')} provider calls.`,
  );

  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').toLowerCase();
  const result = await evaluate({
    dataset,
    provider: setup.provider,
    tempStore: setup.tempStore,
    smallFaceDetector: setup.smallFaceDetector,
    config,
    indexOptions,
    searchOptions,
    sweepFloor: maybeGrid[0]!,
    minStrong: strongGrid[0]!,
    // The fake derives face ids, and so its similarity jitter, from the collection id: keep it stable
    // so synthetic runs are reproducible. Real runs get unique collections.
    collectionTag: setup.name === 'fake' ? 'eval-synthetic' : `eval-${stamp}`,
    concurrency: number(values.concurrency, 4, 'concurrency', 1),
    keepCollections: values['keep-collections'],
    log,
  });

  const positives = new Map(dataset.persons.map((p) => [p.id, p.positives]));
  const positivesOf = (personId: string) => positives.get(personId) ?? new Set<string>();
  const analysis = analyze(
    result.combos,
    result.indexStats,
    positivesOf,
    { strong: strongGrid, maybe: maybeGrid },
    targets,
    assumptions,
  );
  const failures = analyzeFailures(dataset, analysis.recommended, analysis.thresholds);
  const markdown = renderReport({
    generatedAt: started,
    commit: gitCommit(),
    provider: setup.description,
    faceModelVersion: result.faceModelVersion,
    dataset: summary,
    config,
    grids: { strong: strongGrid, maybe: maybeGrid },
    targets,
    assumptions,
    analysis,
    failures,
    harnessCalls: result.harnessCalls,
  });

  const runDir = join(runsDir, `${stamp}-${summary.synthetic ? 'synthetic' : 'real'}`);
  await mkdir(runDir, { recursive: true });
  const recommended = analysis.recommended;
  const perPerson = scoreScans(recommended.result.scans, positivesOf, analysis.thresholds);
  await writeFile(
    join(runDir, 'run.json'),
    `${JSON.stringify(
      {
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        provider: setup.name,
        dataset: { dir: dataset.dir, ...summary },
        photos: dataset.photos,
        config,
        grids: { strong: strongGrid, maybe: maybeGrid, indexOptions, searchOptions },
        targets,
        assumptions,
        indexStats: result.indexStats,
        harnessCalls: result.harnessCalls,
        recommended: { key: recommended.key, thresholds: analysis.thresholds, go: analysis.go },
        combos: analysis.combos.map((c) => ({
          key: c.key,
          operatingPoint: c.operatingPoint,
          atOperatingPoint: {
            strong: summarize(c.at(c.operatingPoint).strong),
            overall: summarize(c.at(c.operatingPoint).overall),
          },
          atRecommended: {
            strong: summarize(c.at(analysis.thresholds).strong),
            overall: summarize(c.at(analysis.thresholds).overall),
          },
          cost: c.costAt(c.operatingPoint),
        })),
        perPerson: { strong: perPerson.strong, overall: perPerson.overall },
        failures,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(runDir, 'scans.json'), `${JSON.stringify(result.combos)}\n`);
  await writeMarkdown(join(runDir, 'report.md'), markdown);
  if (values.report) await writeMarkdown(resolve(values.report), markdown);
  log(`Run output: ${runDir}${values.report ? `\nReport: ${resolve(values.report)}` : ''}`);
  log(
    `Recommended ${recommended.key} at FACE_STRONG=${analysis.thresholds.strong} FACE_MAYBE=${analysis.thresholds.maybe}; ` +
      `${analysis.go.every((g) => g.pass) && analysis.feasible ? 'GO' : 'NO-GO'} on this dataset.`,
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'synth':
      return synthCommand(args);
    case 'validate':
      return validateCommand(args);
    case 'run':
      return runCommand(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

// pnpm passes a literal "--" through when arguments follow `pnpm face-eval --`.
main(process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))).catch(
  (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
