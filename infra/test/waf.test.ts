import { loadFaceConfig, REKOGNITION_INLINE_IMAGE_MAX_BYTES } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { faceSearchLimits } from '../lib/config';
import { decimalGreaterThanRegex } from '../lib/constructs/waf-rules';
import { faceSearchBodyLimits } from '../lib/face-limits';
import { synthPlatform, type Synthesized } from './helpers';
import { matches, ruleApplies, scopeDown, type WafRequest } from './waf-eval';

type Json = Record<string, unknown>;

const s = synthPlatform();
const edge = s.template(s.platform.edge);

function aclRules(synth: Synthesized, name: string): Json[] {
  const [acl] = Object.values(
    synth.template(synth.platform.edge).findResources('AWS::WAFv2::WebACL', {
      Properties: { Name: name },
    }),
  );
  return ((acl as Json).Properties as Json).Rules as Json[];
}
const mainRules = aclRules(s, 'shotx-prod-main');
const adminRules = aclRules(s, 'shotx-prod-admin');
const rule = (rules: Json[], name: string): Json => {
  const r = rules.find((x) => x.Name === name);
  if (r === undefined) throw new Error(`no rule ${name}`);
  return r;
};
const action = (r: Json) => Object.keys(r.Action as Json)[0];

const TOKEN = 'Ab3dEf9hIj2lMn4pQr6tUv';
const post = (path: string, headers: Record<string, string> = {}): WafRequest => ({
  method: 'POST',
  path,
  headers,
});
const get = (path: string): WafRequest => ({ method: 'GET', path });

/** Spellings of the face-search path that NestJS/Express route to the same handler. */
const FACE_SEARCH_VARIANTS: Record<string, string> = {
  canonical: `/api/s/${TOKEN}/face-search`,
  'upper case': `/api/s/${TOKEN}/FACE-SEARCH`,
  'mixed case': `/api/s/${TOKEN}/Face-Search`,
  'upper-case prefix': `/API/S/${TOKEN}/face-search`,
  'trailing slash': `/api/s/${TOKEN}/face-search/`,
  'upper case and trailing slash': `/api/s/${TOKEN}/FACE-SEARCH/`,
  'percent-encoded hyphen': `/api/s/${TOKEN}/face%2Dsearch`,
  'percent-encoded letters': `/api/s/${TOKEN}/%66%61%63%65-search`,
  'percent-encoded upper case': `/api/s/${TOKEN}/%46ACE-%53EARCH`,
  'percent-encoded trailing slash': `/api/s/${TOKEN}/face-search%2F`,
  'percent-encoded prefix': `/api/%73/${TOKEN}/face-search`,
};

/** The same spellings for `POST /api/s/:token/face-deletion` ("ขอลบใบหน้าของฉัน"). */
const FACE_DELETION_VARIANTS: Record<string, string> = Object.fromEntries(
  Object.entries(FACE_SEARCH_VARIANTS).map(([label, path]) => [
    label,
    path
      .replace('face-search', 'face-deletion')
      .replace('FACE-SEARCH', 'FACE-DELETION')
      .replace('Face-Search', 'Face-Deletion')
      .replace('face%2Dsearch', 'face%2Ddeletion')
      .replace('%66%61%63%65-search', '%66%61%63%65-deletion')
      .replace('%46ACE-%53EARCH', '%46ACE-%44ELETION'),
  ]),
);
/** Every face upload route: both share one rate budget, body exemption and size limit. */
const FACE_UPLOAD_VARIANTS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FACE_SEARCH_VARIANTS).map(([l, p]) => [`search ${l}`, p])),
  ...Object.fromEntries(
    Object.entries(FACE_DELETION_VARIANTS).map(([l, p]) => [`deletion ${l}`, p]),
  ),
};

/** Spellings of another public share route, `/api/s/:token/<suffix>`. */
const routeVariants = (suffix: string): Record<string, string> => ({
  canonical: `/api/s/${TOKEN}/${suffix}`,
  'upper case': `/api/s/${TOKEN}/${suffix.toUpperCase()}`,
  'upper-case prefix': `/API/S/${TOKEN}/${suffix}`,
  'trailing slash': `/api/s/${TOKEN}/${suffix}/`,
  'percent-encoded first letter': `/api/s/${TOKEN}/%${suffix.charCodeAt(0).toString(16)}${suffix.slice(1)}`,
  'percent-encoded trailing slash': `/api/s/${TOKEN}/${suffix}%2F`,
  'percent-encoded prefix': `/api/%73/${TOKEN}/${suffix}`,
});

const NOT_FACE_SEARCH = [
  get(`/api/s/${TOKEN}/face-deletion`),
  post(`/api/s/${TOKEN}/face-deletion/extra`),
  post(`/api/s/${TOKEN}/face-deletions`),
  get(`/api/s/${TOKEN}/face-search`),
  post(`/api/s/${TOKEN}/consent`),
  post(`/api/s/${TOKEN}/face-search-feedback`),
  post(`/api/s/${TOKEN}/face-search/extra`),
  post('/api/shares/x/face-search'),
  post('/api/drive/folders'),
];

const SHARE_VARIANTS = [
  `/s/${TOKEN}`,
  `/S/${TOKEN}`,
  `/%73/${TOKEN}`,
  `/api/s/${TOKEN}/items`,
  `/API/S/${TOKEN}/items`,
  `/api/%53/${TOKEN}/consent`,
];
const NOT_SHARE = ['/', '/studio', '/settings', '/api/drive/folders/x/children', '/api/plans'];

describe('WAF path normalisation (face search)', () => {
  const faceRateRules = [
    rule(mainRules, 'face-search-rate-block'),
    rule(mainRules, 'face-search-rate-captcha'),
  ];

  it('URL-decodes and then lowercases every path match', () => {
    let pathMatches = 0;
    for (const r of [...mainRules, ...adminRules]) {
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(visit);
        if (v === null || typeof v !== 'object') return;
        const o = v as Json;
        const st = (o.ByteMatchStatement ?? o.RegexMatchStatement) as Json | undefined;
        if (st !== undefined && 'UriPath' in (st.FieldToMatch as Json)) {
          pathMatches++;
          expect(st.TextTransformations, String(r.Name)).toEqual([
            { Priority: 0, Type: 'URL_DECODE' },
            { Priority: 1, Type: 'LOWERCASE' },
          ]);
        }
        Object.values(o).forEach(visit);
      };
      visit(r.Statement);
    }
    expect(pathMatches).toBeGreaterThan(0);
  });

  for (const [label, path] of Object.entries(FACE_UPLOAD_VARIANTS)) {
    it(`applies both face-search rate rules to POST ${label} (${path})`, () => {
      for (const r of faceRateRules) expect(ruleApplies(r, post(path)), String(r.Name)).toBe(true);
    });
  }

  it('leaves other requests to the share limits', () => {
    for (const req of NOT_FACE_SEARCH) {
      for (const r of faceRateRules) {
        expect(ruleApplies(r, req), `${String(r.Name)} ${req.method} ${req.path}`).toBe(false);
      }
    }
  });

  it('has a block tier evaluated before a CAPTCHA tier', () => {
    const [a, b] = faceRateRules;
    expect(action(a as Json)).toBe('Block');
    expect(action(b as Json)).toBe('Captcha');
    expect((a as Json).Priority as number).toBeLessThan((b as Json).Priority as number);
  });
});

describe('WAF path normalisation (share pages)', () => {
  const shareRules = [rule(mainRules, 'share-rate-block'), rule(mainRules, 'share-rate-captcha')];

  it('rate-limits every spelling of /s/* and /api/s/*', () => {
    for (const path of SHARE_VARIANTS) {
      for (const r of shareRules) {
        expect(ruleApplies(r, get(path)), `${String(r.Name)} ${path}`).toBe(true);
      }
    }
  });

  it('does not rate-limit other pages as shares', () => {
    for (const path of NOT_SHARE) {
      for (const r of shareRules) expect(ruleApplies(r, get(path)), path).toBe(false);
    }
  });

  it('has a block tier evaluated before a CAPTCHA tier', () => {
    const [a, b] = shareRules as [Json, Json];
    expect([action(a), action(b)]).toEqual(['Block', 'Captcha']);
    expect(a.Priority as number).toBeLessThan(b.Priority as number);
  });

  it('rejects mixed-case path settings, which could never match a lowercased path', () => {
    expect(() =>
      synthPlatform((c) => {
        (c.waf as Json).faceSearchPathSuffix = '/Face-Search';
      }),
    ).toThrow(/lowercase/);
  });
});

describe('WAF on the admin distribution', () => {
  const block = rule(adminRules, 'public-share-paths-block');

  it('blocks share pages and face search, which are served on the main domain only', () => {
    expect(action(block)).toBe('Block');
    for (const path of [...SHARE_VARIANTS, ...Object.values(FACE_UPLOAD_VARIANTS)]) {
      expect(matches(block.Statement as Json, post(path)), path).toBe(true);
    }
  });

  it('lets the admin app and its API through', () => {
    for (const path of ['/', '/photographers', '/api/admin/metrics/revenue', '/api/health']) {
      expect(matches(block.Statement as Json, get(path)), path).toBe(false);
    }
  });
});

describe('WAF and face-search uploads', () => {
  const limits = faceSearchLimits(s.config);
  const multipart = (length: number, contentType = 'multipart/form-data; boundary=----shotx') => ({
    'content-type': contentType,
    'content-length': String(length),
  });
  /** Three ~400 KB selfies: a normal scan. */
  const typical = multipart(3 * 400_000 + 2_000);
  const bodyRuleGroups = ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet'];
  const managed = (name: string) => rule(mainRules, `aws-${name}`);

  it('sizes the body limit for FACE_MAX_SELFIES selfies of FACE_SELFIE_LONG_EDGE px', () => {
    const face = loadFaceConfig({});
    const perSelfie = Math.min(
      REKOGNITION_INLINE_IMAGE_MAX_BYTES,
      face.selfie.longEdge ** 2 * s.config.waf.faceSearchBody.jpegBytesPerPixel,
    );
    expect(limits.maxSelfies).toBe(face.search.maxSelfies);
    expect(limits.selfieMaxBytes).toBe(perSelfie);
    expect(limits.maxBodyBytes).toBe(
      face.search.maxSelfies * perSelfie + s.config.waf.faceSearchBody.multipartOverheadBytes,
    );
  });

  it('never allows a selfie above Rekognition’s 5 MB inline limit', () => {
    const big = loadFaceConfig({ FACE_SELFIE_LONG_EDGE: '4096' });
    const l = faceSearchBodyLimits(big, s.config.waf.faceSearchBody);
    expect(l.selfieMaxBytes).toBe(REKOGNITION_INLINE_IMAGE_MAX_BYTES);
  });

  for (const name of bodyRuleGroups) {
    it(`skips ${name} (body-inspecting rules) for face-search uploads`, () => {
      for (const [label, path] of Object.entries(FACE_UPLOAD_VARIANTS)) {
        expect(ruleApplies(managed(name), post(path, typical)), label).toBe(false);
        expect(
          ruleApplies(
            managed(name),
            post(path, multipart(1000, 'Multipart/Form-Data; boundary=x')),
          ),
          `${label}, mixed-case content type`,
        ).toBe(false);
      }
    });

    it(`keeps ${name} on every other request`, () => {
      const others: WafRequest[] = [
        post(`/api/s/${TOKEN}/face-search`, {
          'content-type': 'application/json',
          'content-length': '200',
        }),
        get(`/api/s/${TOKEN}/face-search`),
        get(`/s/${TOKEN}`),
        post(`/api/s/${TOKEN}/consent`, { 'content-type': 'application/json' }),
        post(`/api/s/${TOKEN}/unlock`, typical),
        post('/api/drive/folders', { 'content-type': 'application/json' }),
        post('/api/uploads/init', { 'content-type': 'application/json' }),
        post('/api/billing/webhooks/opn', { 'content-type': 'application/json' }),
        post('/', typical),
      ];
      for (const req of others) {
        expect(ruleApplies(managed(name), req), `${req.method} ${req.path}`).toBe(true);
      }
    });
  }

  it('keeps IP reputation and the global rate limit on face-search uploads', () => {
    for (const name of ['aws-AWSManagedRulesAmazonIpReputationList', 'global-rate-block']) {
      const r = rule(mainRules, name);
      expect(scopeDown(r), name).toBeUndefined();
    }
  });

  it('keeps every managed rule group on the admin distribution unscoped', () => {
    for (const r of adminRules.filter(
      (x) => (x.Statement as Json).ManagedRuleGroupStatement !== undefined,
    )) {
      expect(scopeDown(r), String(r.Name)).toBeUndefined();
    }
  });

  describe('body-size rule', () => {
    const tooLarge = rule(mainRules, 'face-search-body-too-large');
    const path = FACE_SEARCH_VARIANTS.canonical as string;
    const blocks = (req: WafRequest) => matches(tooLarge.Statement as Json, req);

    it('answers 413 with the API error envelope', () => {
      expect(tooLarge.Action).toEqual({
        Block: {
          CustomResponse: { ResponseCode: 413, CustomResponseBodyKey: 'payload_too_large' },
        },
      });
    });

    it('lets normal scans and the largest allowed body through', () => {
      expect(blocks(post(path, typical))).toBe(false);
      expect(blocks(post(path, multipart(limits.maxBodyBytes)))).toBe(false);
      expect(blocks(post(path, multipart(0)))).toBe(false);
    });

    it('blocks bodies over the limit on every spelling of the path', () => {
      for (const [label, p] of Object.entries(FACE_UPLOAD_VARIANTS)) {
        expect(blocks(post(p, multipart(limits.maxBodyBytes + 1))), label).toBe(true);
        expect(blocks(post(p, multipart(10 * limits.maxBodyBytes))), label).toBe(true);
      }
      expect(
        blocks(post(path, { 'content-length': `000${limits.maxBodyBytes + 1}` })),
        'leading zeros',
      ).toBe(true);
    });

    it('only looks at face-search posts', () => {
      expect(blocks(post('/api/drive/folders', multipart(10 * limits.maxBodyBytes)))).toBe(false);
    });

    it('follows FACE_MAX_SELFIES and FACE_SELFIE_LONG_EDGE from the api environment', () => {
      const edited = synthPlatform((c) => {
        const env = (c.services as Json).env as Json;
        env.api = { FACE_MAX_SELFIES: '5', FACE_SELFIE_LONG_EDGE: '640' };
      });
      const l = faceSearchLimits(edited.config);
      expect(l.selfieMaxBytes).toBe(640 * 640 * 3);
      expect(l.maxBodyBytes).toBe(5 * 640 * 640 * 3 + 65_536);
      const r = rule(aclRules(edited, 'shotx-prod-main'), 'face-search-body-too-large');
      const at = (n: number) => matches(r.Statement as Json, post(path, multipart(n)));
      expect(at(l.maxBodyBytes)).toBe(false);
      expect(at(l.maxBodyBytes + 1)).toBe(true);
    });
  });

  it('inspects the CloudFront default body size (16 KB) on both web ACLs', () => {
    edge.allResourcesProperties('AWS::WAFv2::WebACL', {
      AssociationConfig: { RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_16' } } },
    });
  });
});

describe('WAF and face deletion ("ขอลบใบหน้าของฉัน")', () => {
  it('shares the face-search rate rules, CAPTCHA included', () => {
    for (const name of ['face-search-rate-block', 'face-search-rate-captcha']) {
      for (const [label, path] of Object.entries(FACE_DELETION_VARIANTS)) {
        expect(ruleApplies(rule(mainRules, name), post(path)), `${name} ${label}`).toBe(true);
      }
    }
  });

  it('gets the managed-rule body exemption and the 413 limit of face search', () => {
    const limits = faceSearchLimits(s.config);
    const upload = (length: number) => ({
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': String(length),
    });
    const tooLarge = rule(mainRules, 'face-search-body-too-large');
    for (const [label, path] of Object.entries(FACE_DELETION_VARIANTS)) {
      for (const name of ['AWSManagedRulesCommonRuleSet', 'AWSManagedRulesKnownBadInputsRuleSet']) {
        expect(ruleApplies(rule(mainRules, `aws-${name}`), post(path, upload(1_000))), label).toBe(
          false,
        );
      }
      expect(matches(tooLarge.Statement as Json, post(path, upload(limits.maxBodyBytes)))).toBe(
        false,
      );
      expect(
        matches(tooLarge.Statement as Json, post(path, upload(limits.maxBodyBytes + 1))),
        label,
      ).toBe(true);
    }
  });
});

describe('WAF rate rules on unlock and downloads', () => {
  for (const [suffix, name, limitKey] of [
    ['unlock', 'share-unlock-rate-block', 'unlockBlockRateLimit'],
    ['downloads', 'share-downloads-rate-block', 'downloadsBlockRateLimit'],
  ] as const) {
    describe(`POST /api/s/:token/${suffix}`, () => {
      const r = rule(mainRules, name);

      it('blocks with 429 and the RATE_LIMITED body at the configured per-IP limit', () => {
        expect(r.Action).toEqual({
          Block: { CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: 'rate_limited' } },
        });
        const rate = (r.Statement as Json).RateBasedStatement as Json;
        expect(rate.Limit).toBe(s.config.waf[limitKey]);
        expect(rate.AggregateKeyType).toBe('IP');
        expect(rate.EvaluationWindowSec).toBe(s.config.waf.evaluationWindowSeconds);
      });

      it('counts every spelling of the path', () => {
        for (const [label, path] of Object.entries(routeVariants(suffix))) {
          expect(ruleApplies(r, post(path)), `${label} ${path}`).toBe(true);
        }
      });

      it('ignores other methods and routes', () => {
        for (const req of [
          get(`/api/s/${TOKEN}/${suffix}`),
          post(`/api/s/${TOKEN}/${suffix}/extra`),
          post(`/api/s/${TOKEN}/${suffix}x`),
          post(`/api/s/${TOKEN}/consent`),
          post(`/s/${TOKEN}/${suffix}`),
          post(`/api/shares/${TOKEN}/${suffix}`),
        ]) {
          expect(ruleApplies(r, req), `${req.method} ${req.path}`).toBe(false);
        }
      });

      it('runs before the general share rules, so it sees every request', () => {
        expect(r.Priority as number).toBeLessThan(
          rule(mainRules, 'share-rate-block').Priority as number,
        );
      });
    });
  }

  it('gives every main ACL rule a unique priority', () => {
    const priorities = mainRules.map((x) => x.Priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe('decimalGreaterThanRegex', () => {
  it('matches exactly the integers above n', () => {
    for (let n = 0; n <= 1200; n++) {
      const re = new RegExp(decimalGreaterThanRegex(n));
      for (let x = 0; x <= 1300; x += n < 50 ? 1 : 7) {
        expect(re.test(String(x)), `${x} > ${n}`).toBe(x > n);
      }
      expect(re.test(String(n + 1))).toBe(true);
      expect(re.test(String(n))).toBe(false);
    }
  });

  it('handles large limits, leading zeros and non-numbers', () => {
    for (const n of [14_811_136, 9_999_999, 10_000_000, 15_793_152, 99]) {
      const re = new RegExp(decimalGreaterThanRegex(n));
      for (const x of [0, 1, n - 1, n, n + 1, n + 9, n * 10, 2 ** 40]) {
        expect(re.test(String(x)), `${x} > ${n}`).toBe(x > n);
        expect(re.test(`00${x}`), `00${x} > ${n}`).toBe(x > n);
      }
      expect(re.test('')).toBe(false);
      expect(re.test(`${n + 1}abc`)).toBe(false);
      expect(re.test(`-${n + 1}`)).toBe(false);
    }
  });
});
