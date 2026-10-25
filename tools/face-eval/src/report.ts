import type { FaceConfig } from '@shotx/shared';
import {
  type Analysis,
  type CallEstimate,
  type ComboAnalysis,
  type CostAssumptions,
  type Dimension,
  DIMENSIONS,
  type Targets,
  valueOf,
  vary,
} from './analysis';
import type { CallCounts } from './counting-provider';
import { totalCalls } from './counting-provider';
import type { describeDataset } from './dataset';
import type { FailureSummary } from './failures';
import type { Summary, Thresholds } from './metrics';

export interface ReportInput {
  generatedAt: Date;
  commit: string | undefined;
  provider: string;
  faceModelVersion: string | undefined;
  dataset: ReturnType<typeof describeDataset>;
  config: FaceConfig;
  grids: { strong: number[]; maybe: number[] };
  targets: Targets;
  assumptions: CostAssumptions;
  analysis: Analysis;
  failures: FailureSummary;
  harnessCalls: CallCounts;
}

export const SYNTHETIC_DISCLAIMER = [
  '> **SYNTHETIC DATA: NOT A BASIS FOR PRODUCTION THRESHOLDS.**',
  '> Every number below comes from a synthetic dataset (`face-eval synth`) scored by the',
  '> deterministic FakeFaceProvider, not by Amazon Rekognition. It shows that the harness works and',
  '> how to read the report. Choose FACE_STRONG, FACE_MAYBE and the pipeline options only from a',
  '> run on the real event dataset (see tools/face-eval/README.md).',
];

const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`;
const interval = (ci: [number, number] | null) =>
  ci ? `${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%` : '–';
const int = (v: number) => Math.round(v).toLocaleString('en-US');
const dec = (v: number, digits = 2) => v.toFixed(digits);
const usd = (v: number) => `$${v < 10 ? v.toFixed(2) : int(v)}`;
const thb = (v: number) => `฿${v < 10 ? v.toFixed(2) : int(v)}`;

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const line = (cells: Array<string | number>) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const DIMENSION_LABEL: Record<Dimension, string> = {
  longEdge: 'Index long edge',
  qualityFilter: 'IndexFaces QualityFilter',
  tiling: 'Tiling',
  expansionSeeds: 'Expansion',
  selfies: 'Selfies per scan',
};

function optionValue(dimension: Dimension, value: string | number): string {
  if (dimension === 'longEdge') return `${value} px`;
  if (dimension === 'expansionSeeds') return value === 0 ? 'off' : `on (${value} seeds)`;
  return String(value);
}

function describeCombo(combo: ComboAnalysis): string {
  return DIMENSIONS.map((d) => `${DIMENSION_LABEL[d]} ${optionValue(d, valueOf(combo, d))}`).join(
    ', ',
  );
}

function headline(label: string, summary: Summary): string[] {
  const { micro, macro, zeroResult } = summary;
  return [
    `- **${label}:** micro precision ${pct(micro.precision)} (95% CI ${interval(micro.precisionCi)}), ` +
      `micro recall ${pct(micro.recall)} (95% CI ${interval(micro.recallCi)}), micro F1 ${pct(micro.f1)}; ` +
      `macro precision ${pct(macro.precision)}, macro recall ${pct(macro.recall)}, macro F1 ${pct(macro.f1)}; ` +
      `zero-result rate ${pct(zeroResult.rate)} (${zeroResult.persons} of ${zeroResult.of} persons).`,
  ];
}

function costLine(cost: CallEstimate, assumptions: CostAssumptions): string[] {
  const p = cost.per1000Photos;
  return [
    `- **Rekognition calls per 1,000 photos:** ${int(p.totalCalls)} = ${int(p.indexCalls)} for ` +
      `indexing (${dec(cost.indexCallsPerPhoto)} IndexFaces + ${dec(cost.deleteCallsPerPhoto)} DeleteFaces per photo) ` +
      `+ ${int(p.searchCalls)} for ${int(assumptions.scansPer1000Photos)} scans ` +
      `(${dec(cost.searchCallsPerScan)} calls per scan). About ${usd(p.callsUsd)} (${thb(p.callsThb)}), ` +
      `plus ${usd(p.storageUsdPerMonth)} per month to keep ${int(p.faces)} faces indexed ` +
      `(${thb(p.storageThbForRetention)} over ${assumptions.retentionMonths} months).`,
  ];
}

function recommendationTable(input: ReportInput): string {
  const { analysis, config } = input;
  const rec = analysis.recommended;
  const t = analysis.thresholds;
  return table(
    ['Setting', 'Config key', 'Recommended', 'Value in this run’s config'],
    [
      ['"ใช่คุณ" threshold', '`FACE_STRONG`', t.strong, config.thresholds.strong],
      ['"อาจจะเป็นคุณ" threshold', '`FACE_MAYBE`', t.maybe, config.thresholds.maybe],
      [
        'Index long edge',
        '`FACE_INDEX_LONG_EDGE`',
        `${rec.index.longEdge} px`,
        `${config.index.longEdge} px`,
      ],
      [
        'IndexFaces QualityFilter',
        '`FACE_INDEX_QUALITY_FILTER`',
        rec.index.qualityFilter,
        config.index.qualityFilter,
      ],
      ['Tiling', 'none yet (requested: `FACE_INDEX_TILING`)', rec.index.tiling, '–'],
      [
        'Expansion seeds (0 = off)',
        '`FACE_EXPANSION_SEEDS`',
        rec.search.expansionSeeds,
        config.search.expansionSeeds,
      ],
      ['Selfies per scan', '`FACE_MAX_SELFIES`', rec.search.selfies, config.search.maxSelfies],
    ],
  );
}

function strongSweep(input: ReportInput): string {
  const rec = input.analysis.recommended;
  return table(
    [
      'FACE_STRONG',
      'Precision (micro)',
      '95% CI',
      'Recall (micro)',
      'F1 (micro)',
      'Precision (macro)',
      'Recall (macro)',
      'F1 (macro)',
      'Zero-result',
      'Search calls / scan',
    ],
    input.grids.strong.map((s) => {
      const at = rec.at({ strong: s, maybe: s });
      const { micro, macro, zeroResult } = at.strongSummary;
      const mark = s === input.analysis.thresholds.strong ? ` **←**` : '';
      return [
        `${s}${mark}`,
        pct(micro.precision),
        interval(micro.precisionCi),
        pct(micro.recall),
        pct(micro.f1),
        pct(macro.precision),
        pct(macro.recall),
        pct(macro.f1),
        pct(zeroResult.rate),
        dec(at.searchCallsPerScan),
      ];
    }),
  );
}

function maybeSweep(input: ReportInput): string {
  const rec = input.analysis.recommended;
  const strong = input.analysis.thresholds.strong;
  const maybes = [...new Set([...input.grids.maybe.filter((m) => m <= strong), strong])].sort(
    (a, b) => a - b,
  );
  return table(
    [
      'FACE_MAYBE',
      'Precision (micro)',
      '95% CI',
      'Recall (micro)',
      'F1 (micro)',
      'Precision (macro)',
      'Recall (macro)',
      'F1 (macro)',
      'Zero-result',
      'Absent persons with results',
    ],
    maybes.map((m) => {
      const { micro, macro, zeroResult, absentWithResults } = rec.at({
        strong,
        maybe: m,
      }).overallSummary;
      const mark = m === input.analysis.thresholds.maybe ? ` **←**` : '';
      return [
        `${m}${mark}`,
        pct(micro.precision),
        interval(micro.precisionCi),
        pct(micro.recall),
        pct(micro.f1),
        pct(macro.precision),
        pct(macro.recall),
        pct(macro.f1),
        pct(zeroResult.rate),
        `${absentWithResults.persons} of ${absentWithResults.of}`,
      ];
    }),
  );
}

function optionTables(input: ReportInput): string[] {
  const t: Thresholds = input.analysis.thresholds;
  const out: string[] = [];
  for (const dimension of DIMENSIONS) {
    const combos = vary(input.analysis, dimension);
    if (combos.length < 2) continue;
    out.push(`### ${DIMENSION_LABEL[dimension]}`, '');
    out.push(
      table(
        [
          'Value',
          'Strong P',
          'Strong R',
          'Strong+maybe P',
          'Strong+maybe R',
          'Strong+maybe F1',
          'Macro R',
          'Zero-result',
          'Calls / 1,000 photos',
          'Own FACE_STRONG / FACE_MAYBE',
          'Recall there',
        ],
        combos.map((c) => {
          const at = c.at(t);
          const own = c.at(c.operatingPoint).overallSummary;
          const recommended = c === input.analysis.recommended ? ' **(recommended)**' : '';
          const met =
            c.operatingPoint.strongMet && c.operatingPoint.overallMet ? '' : ' (targets missed)';
          return [
            `${optionValue(dimension, valueOf(c, dimension))}${recommended}`,
            pct(at.strongSummary.micro.precision),
            pct(at.strongSummary.micro.recall),
            pct(at.overallSummary.micro.precision),
            pct(at.overallSummary.micro.recall),
            pct(at.overallSummary.micro.f1),
            pct(at.overallSummary.macro.recall),
            pct(at.overallSummary.zeroResult.rate),
            int(c.costAt(t).per1000Photos.totalCalls),
            `${c.operatingPoint.strong} / ${c.operatingPoint.maybe}${met}`,
            pct(own.micro.recall),
          ];
        }),
      ),
      '',
    );
  }
  return out;
}

function costTable(input: ReportInput): string {
  const t = input.analysis.thresholds;
  const seen = new Set<string>();
  const rows: Array<Array<string | number>> = [];
  for (const dimension of DIMENSIONS) {
    for (const c of vary(input.analysis, dimension)) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const cost = c.costAt(t);
      const p = cost.per1000Photos;
      rows.push([
        `\`${c.key}\`${c === input.analysis.recommended ? ' **(recommended)**' : ''}`,
        dec(cost.indexCallsPerPhoto),
        dec(cost.deleteCallsPerPhoto),
        dec(cost.searchCallsPerScan),
        int(p.indexCalls),
        int(p.searchCalls),
        int(p.totalCalls),
        usd(p.callsUsd),
        thb(p.callsThb),
        int(p.faces),
        usd(p.storageUsdPerMonth),
      ]);
    }
  }
  return table(
    [
      'Option (`le<px>-<filter>-<tiling>/s<selfies>-x<seeds>`)',
      'IndexFaces / photo',
      'DeleteFaces / photo',
      'Search calls / scan',
      'Index calls / 1,000 photos',
      'Search calls / 1,000 photos',
      'Total calls / 1,000 photos',
      'USD',
      'THB',
      'Faces stored / 1,000 photos',
      'Face storage USD / month',
    ],
    rows,
  );
}

function failureSection(input: ReportInput): string[] {
  const f = input.failures;
  const out = [
    table(
      ['What', 'Count'],
      [
        [
          'Appearances missed, returned below FACE_MAYBE (a lower threshold would find them)',
          f.missedBelowMaybe,
        ],
        [
          'Appearances missed, not returned at all (face not indexed, or too dissimilar)',
          f.missedNotFound,
        ],
        ['Wrong photos in "ใช่คุณ"', f.falseStrong],
        ['Persons with at least one wrong "ใช่คุณ" photo', f.personsWithFalseStrong],
        ['Wrong photos in "อาจจะเป็นคุณ"', f.falseMaybe],
        ['Present persons with zero results', f.zeroResultPersons],
        ['… of whom no selfie had a detectable face', f.zeroResultNoFace],
        ['Selfies without a detectable face', f.selfiesWithoutFace],
        ['Scans where a call hit MaxFaces (results may be cut off)', f.truncatedScans],
      ],
    ),
    '',
  ];
  if (f.bySize && f.byPose) {
    out.push(
      'Synthetic only: strong+maybe recall by face width in the original photo and by pose.',
      '',
      table(
        ['Face width', 'Appearances', 'Found', 'Recall'],
        f.bySize.map((b) => [
          b.label,
          b.positives,
          b.found,
          pct(b.positives ? b.found / b.positives : null),
        ]),
      ),
      '',
      table(
        ['Pose', 'Appearances', 'Found', 'Recall'],
        f.byPose.map((b) => [
          b.label,
          b.positives,
          b.found,
          pct(b.positives ? b.found / b.positives : null),
        ]),
      ),
      '',
    );
  }
  return out;
}

function appendix(input: ReportInput): string {
  return table(
    [
      'Option',
      'FACE_STRONG',
      'FACE_MAYBE',
      'Targets met',
      'Strong P',
      'Strong R',
      'Strong+maybe P',
      'Strong+maybe R',
      'Strong+maybe F1',
      'Macro R',
      'Zero-result',
      'Calls / 1,000 photos',
    ],
    input.analysis.combos.map((c) => {
      const op = c.operatingPoint;
      const at = c.at(op);
      return [
        `\`${c.key}\``,
        op.strong,
        op.maybe,
        op.strongMet && op.overallMet ? 'yes' : 'no',
        pct(at.strongSummary.micro.precision),
        pct(at.strongSummary.micro.recall),
        pct(at.overallSummary.micro.precision),
        pct(at.overallSummary.micro.recall),
        pct(at.overallSummary.micro.f1),
        pct(at.overallSummary.macro.recall),
        pct(at.overallSummary.zeroResult.rate),
        int(c.costAt(op).per1000Photos.totalCalls),
      ];
    }),
  );
}

export function renderReport(input: ReportInput): string {
  const { analysis, dataset, targets, assumptions } = input;
  const rec = analysis.recommended;
  const t = analysis.thresholds;
  const scored = rec.at(t);
  const go = analysis.go.every((g) => g.pass) && analysis.feasible;
  const range = (values: number[]) => `${values[0]}–${values.at(-1)}`;
  const index = [...new Set(analysis.combos.map((c) => c.index.longEdge))].join(', ');
  const lines: string[] = [];

  if (dataset.synthetic) lines.push(...SYNTHETIC_DISCLAIMER, '');
  lines.push(
    `# Face search evaluation: ${dataset.event ?? 'unnamed event'}`,
    '',
    `- Generated ${input.generatedAt.toISOString()}${input.commit ? ` from commit \`${input.commit}\`` : ''}.`,
    `- Provider: ${input.provider}${input.faceModelVersion ? `, face model ${input.faceModelVersion}` : ''}.`,
    `- Dataset: ${dataset.photos} photos (${dataset.photosWithoutVolunteers} without any volunteer), ` +
      `${dataset.persons} volunteers (${dataset.personsAbsent} in no photo), ${dataset.appearances} labelled appearances, ${dataset.selfies} selfies.`,
    `- Grid: index long edge ${index} px; QualityFilter ${[...new Set(analysis.combos.map((c) => c.index.qualityFilter))].join(', ')}; ` +
      `tiling ${[...new Set(analysis.combos.map((c) => c.index.tiling))].join(', ')}; ` +
      `expansion seeds ${[...new Set(analysis.combos.map((c) => c.search.expansionSeeds))].join(', ')}; ` +
      `selfies ${[...new Set(analysis.combos.map((c) => c.search.selfies))].join(', ')}; ` +
      `FACE_STRONG ${range(input.grids.strong)}; FACE_MAYBE ${range(input.grids.maybe)}.`,
    `- Targets: "ใช่คุณ" precision ≥ ${pct(targets.strongPrecision, 0)}, strong+maybe precision ≥ ${pct(targets.overallPrecision, 0)}; ` +
      `options within ${pct(targets.recallTolerance, 0)} recall of the best count as equal and the cheapest wins.`,
    '',
    '## Recommendation',
    '',
    analysis.feasible
      ? `Recommended pipeline: ${describeCombo(rec)}.`
      : `**No option met both precision targets.** The option with the best strong+maybe F1 is shown: ${describeCombo(rec)}.`,
    '',
    recommendationTable(input),
    '',
    ...headline('"ใช่คุณ" (strong)', scored.strongSummary),
    ...headline('"ใช่คุณ" + "อาจจะเป็นคุณ" (strong+maybe)', scored.overallSummary),
    `- **Expansion:** ${scored.expansionOnlyHits} correct photos were found only through expansion.`,
    ...costLine(rec.costAt(t), assumptions),
    '',
    '## Go / no-go',
    '',
    table(
      ['Criterion', 'Target', 'Actual', 'Result'],
      analysis.go.map((g) => [g.criterion, g.target, pct(g.actual), g.pass ? 'PASS' : 'FAIL']),
    ),
    '',
    dataset.synthetic
      ? `Verdict on this synthetic data: ${go ? 'GO' : 'NO-GO'}. It says nothing about Rekognition on real photos.`
      : `Verdict: **${go ? 'GO' : 'NO-GO'}**.`,
    '',
    '## How to read this report',
    '',
    '- A **scan** is one volunteer searching with their selfies, exactly as on the share page. For each scan the harness compares the photos returned with the photos the volunteer is labelled in.',
    '- **Strong** counts only the "ใช่คุณ" group (similarity ≥ FACE_STRONG). **Strong+maybe** counts both groups (≥ FACE_MAYBE).',
    '- **Micro** sums true positives, false positives and false negatives over all volunteers, then computes precision = TP / (TP + FP), recall = TP / (TP + FN) and F1. Volunteers in many photos weigh more.',
    '- **Macro** computes the rates per volunteer, then averages them, so every volunteer weighs the same. Macro precision averages volunteers who got at least one photo back; macro recall and F1 average volunteers who are in at least one photo (F1 is 0 when none of their photos came back).',
    '- **Zero-result rate** is the share of volunteers who appear in the event but got nothing back. Production tracks the same number per scan.',
    '- **95% CI** is a Wilson interval on the micro rate. It treats every (volunteer, photo) pair as independent, so the real uncertainty is larger, especially with few volunteers.',
    '- Each option has its **own operating point**: the lowest FACE_STRONG whose strong precision meets the target at that value and every value above it, then the lowest FACE_MAYBE that does the same for strong+maybe precision.',
    `- **Calls per 1,000 photos** = indexing calls measured on this dataset, scaled to 1,000 photos, + ${int(assumptions.scansPer1000Photos)} scans × search calls per scan (an assumption: replace it with production scan counts). USD uses REKOGNITION_CALL = $${assumptions.cost.rekognitionCall} and REKOGNITION_FACE_MONTH = $${assumptions.cost.rekognitionFaceMonth}; THB uses USD_THB = ${assumptions.cost.usdThb}.`,
    '',
    `## Threshold sweep (recommended pipeline)`,
    '',
    '### "ใช่คุณ" by FACE_STRONG',
    '',
    strongSweep(input),
    '',
    `### "ใช่คุณ" + "อาจจะเป็นคุณ" by FACE_MAYBE, at FACE_STRONG = ${t.strong}`,
    '',
    maybeSweep(input),
    '',
    `## Pipeline options`,
    '',
    `Each table changes one option of the recommended pipeline and scores it at FACE_STRONG = ${t.strong} and FACE_MAYBE = ${t.maybe}. The last two columns show the option's own operating point.`,
    '',
    ...optionTables(input),
    '## Rekognition calls and cost',
    '',
    costTable(input),
    '',
    `This evaluation itself made ${int(totalCalls(input.harnessCalls))} provider calls ` +
      `(${int(input.harnessCalls.indexFaces)} IndexFaces, ${int(input.harnessCalls.searchFacesByImage)} SearchFacesByImage, ` +
      `${int(input.harnessCalls.searchFaces)} SearchFaces, ${int(input.harnessCalls.deleteFaces)} DeleteFaces).`,
    '',
    `## Failure analysis (recommended pipeline at ${t.strong} / ${t.maybe})`,
    '',
    ...failureSection(input),
    '## Appendix: every option at its own operating point',
    '',
    appendix(input),
    '',
  );
  return lines.join('\n');
}
