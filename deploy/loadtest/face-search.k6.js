// Post-race face-search spike against a STAGING copy (deploy/LOADTEST.md). Never production:
// every scan calls Rekognition (billed) and writes consents and activity events.
//
//   k6 run -e BASE_URL=https://staging.photos.example.com -e PRODUCTION_HOST=photos.example.com \
//     -e I_AM_SURE_THIS_IS_STAGING=yes -e SHARE_TOKENS=tok1,tok2 \
//     -e SELFIE_DIR=./selfies -e SELFIE_COUNT=20 deploy/loadtest/face-search.k6.js
//
// SELFIE_DIR holds selfie-01.jpg ... selfie-NN.jpg of consenting volunteers (never real
// attendees' photos; the directory is git-ignored). Each virtual user is one viewer: a fresh
// cookie jar (anon id), consent, then one face search with one selfie.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const TOKENS = (__ENV.SHARE_TOKENS || '').split(',').filter((t) => t !== '');
const POLICY_VERSION = __ENV.CONSENT_POLICY_VERSION || '2026-10-25';
const SELFIE_COUNT = Number(__ENV.SELFIE_COUNT || '1');
const SELFIE_DIR = __ENV.SELFIE_DIR || './selfies';

if (!BASE_URL || TOKENS.length === 0) fail('set BASE_URL and SHARE_TOKENS');
// Two locks against hitting production: the production host must be named and differ, and the
// operator confirms.
const PRODUCTION_HOST = __ENV.PRODUCTION_HOST;
const host = BASE_URL.replace(/^https?:\/\//, '').split('/')[0];
if (!PRODUCTION_HOST || host === PRODUCTION_HOST || __ENV.I_AM_SURE_THIS_IS_STAGING !== 'yes') {
  fail(
    'refusing to run: set PRODUCTION_HOST, point BASE_URL at staging and I_AM_SURE_THIS_IS_STAGING=yes',
  );
}

// open() runs once per VU at init; keep the set small.
const selfies = Array.from({ length: SELFIE_COUNT }, (_, i) =>
  open(`${SELFIE_DIR}/selfie-${String(i + 1).padStart(2, '0')}.jpg`, 'b'),
);

const scanDuration = new Trend('face_search_duration', true);
const rateLimited = new Counter('face_search_rate_limited');
const unavailable = new Counter('face_search_unavailable');

// The spike: thousands of finishers scan within minutes of the results going up. Tune the
// targets to the event size; the plan in LOADTEST.md has the steps.
export const options = {
  scenarios: {
    post_race_spike: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || '50'),
      maxVUs: Number(__ENV.MAX_VUS || '500'),
      stages: [
        { target: Number(__ENV.RATE_WARM || '2'), duration: __ENV.WARM || '2m' },
        { target: Number(__ENV.RATE_PEAK || '20'), duration: __ENV.RAMP || '3m' },
        { target: Number(__ENV.RATE_PEAK || '20'), duration: __ENV.HOLD || '10m' },
        { target: 0, duration: '2m' },
      ],
    },
  },
  thresholds: {
    // Targets to confirm with the owner (LOADTEST.md).
    face_search_duration: ['p(95)<4000', 'p(99)<8000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const token = TOKENS[Math.floor(Math.random() * TOKENS.length)];
  const share = http.get(`${BASE_URL}/api/s/${token}`, { tags: { step: 'share' } });
  check(share, { 'share 200': (r) => r.status === 200 });

  const consent = http.post(
    `${BASE_URL}/api/s/${token}/consent`,
    JSON.stringify({ purpose: 'face_search', policyVersion: POLICY_VERSION, accepted: true }),
    { headers: { 'content-type': 'application/json' }, tags: { step: 'consent' } },
  );
  check(consent, { 'consent 200': (r) => r.status === 200 });

  const selfie = selfies[Math.floor(Math.random() * selfies.length)];
  const res = http.post(
    `${BASE_URL}/api/s/${token}/face-search`,
    { selfie: http.file(selfie, 'selfie.jpg', 'image/jpeg') },
    { tags: { step: 'face-search' }, timeout: '30s' },
  );
  scanDuration.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  if (res.status === 503) unavailable.add(1);
  // Never print response bodies: they hold signed URLs of other people's photos.
  check(res, { 'face-search 200': (r) => r.status === 200 });
}
