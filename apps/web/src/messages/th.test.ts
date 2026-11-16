import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BILLING_MODES,
  BILLING_NOTICE_CODES,
  CHECKOUT_CHANGE_TYPES,
  CONSENT_POLICY_FACE_PROVIDER,
  CONSENT_POLICY_VERSIONS,
  CONSENT_PURPOSES,
  type ConsentPolicyVersion,
  type ConsentPurpose,
  DOWNLOAD_SIZES,
  DRIVE_UPLOADS_BLOCKED_BY,
  PAYMENT_STATUSES,
  PLAN_CHANGE_INVALID_REASONS,
  FILE_STATUSES,
  LATEST_CONSENT_POLICY_VERSION,
  SHARE_MODES,
  SHARE_STATUSES,
  SHARE_UNAVAILABLE_REASONS,
  SUBSCRIPTION_STATUSES,
  ZIP_JOB_VIEW_STATUSES,
} from '@shotx/shared';
import { SELFIE_ISSUES } from '../lib/face/quality-gate';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { th } from './th';

/** Every leaf message as [dotted key, text]. */
function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Sample values for every ICU argument in a message. */
function sampleArgs(message: string): Record<string, string | number> {
  const args: Record<string, string | number> = {};
  for (const match of message.matchAll(/\{(\w+)(?:,\s*(\w+))?/g)) {
    const [, name, type] = match;
    if (name !== undefined) args[name] = type === 'number' ? 3 : 'x';
  }
  return args;
}

const SRC = path.join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('Thai messages', () => {
  const all = leaves(th);

  it('are all non-empty and format with their arguments', () => {
    const errors: string[] = [];
    const t = createTranslator({
      locale: 'th',
      messages: th,
      onError: (error) => errors.push(error.message),
    });
    for (const [key, text] of all) {
      expect(text.trim(), key).not.toBe('');
      const out = t(key as never, sampleArgs(text) as never);
      expect(out, key).not.toBe(key);
    }
    expect(errors).toEqual([]);
  });

  it('cover every enum the UI shows', () => {
    expect(Object.keys(th.usage.subscriptionStatus).sort()).toEqual(
      [...SUBSCRIPTION_STATUSES].sort(),
    );
    expect(Object.keys(th.drive.fileStatus).sort()).toEqual([...FILE_STATUSES].sort());
    expect(Object.keys(th.usage.blocked).sort()).toEqual([...DRIVE_UPLOADS_BLOCKED_BY].sort());
    const same = (record: object, values: readonly string[]) =>
      expect(Object.keys(record).sort()).toEqual([...values].sort());
    same(th.shares.status, SHARE_STATUSES);
    same(th.shareForm.modes, SHARE_MODES);
    same(th.shareForm.downloadSizes, DOWNLOAD_SIZES);
    same(th.downloads.zipStatus, ZIP_JOB_VIEW_STATUSES);
    same(th.share.unavailable.reasons, SHARE_UNAVAILABLE_REASONS);
    same(th.capture.issues, SELFIE_ISSUES);
    same(th.billing.checkout.changeTypes, CHECKOUT_CHANGE_TYPES);
    same(th.billing.checkout.explain, CHECKOUT_CHANGE_TYPES);
    same(th.billing.payment.status, PAYMENT_STATUSES);
    same(th.billing.current.modes, BILLING_MODES);
    same(th.errors.planChange, PLAN_CHANGE_INVALID_REASONS);
    same(th.errors.notices, BILLING_NOTICE_CODES);
  });

  it('have the billing wording the spec requires', () => {
    expect(th.billing.banners.grace).toContain('ต่ออายุภายใน');
    expect(th.billing.checkout.explain.upgrade).toContain('ทันที');
    expect(th.billing.checkout.explain.downgrade).toContain('ครบรอบ');
    expect(th.billing.checkout.explain.downgrade).toContain('ระบบจะไม่ลบไฟล์');
    expect(th.pricing.vatIncluded).toContain('รวมภาษีมูลค่าเพิ่ม');
  });

  /** A version's whole text: visible points and intro plus the "อ่านรายละเอียด" details. */
  const fullText = (purpose: ConsentPurpose, version: ConsentPolicyVersion) =>
    leaves(th.consent.policies[purpose][version])
      .map(([, text]) => text)
      .join('\n');

  it('have consent text for every purpose and policy version, in Thai', () => {
    expect(Object.keys(th.consent.policies).sort()).toEqual([...CONSENT_PURPOSES].sort());
    for (const purpose of CONSENT_PURPOSES) {
      expect(Object.keys(th.consent.policies[purpose]).sort()).toEqual(
        [...CONSENT_POLICY_VERSIONS].sort(),
      );
      for (const version of CONSENT_POLICY_VERSIONS) {
        for (const [key, text] of leaves(th.consent.policies[purpose][version])) {
          expect(text, `${purpose}.${version}.${key}`).toMatch(/[฀-๿]/);
        }
        // Every text (visible or behind "อ่านรายละเอียด") names PDPA's sensitive-data section
        // and the no-storage promise.
        const text = fullText(purpose, version);
        expect(text, `${purpose}.${version}`).toContain('มาตรา 26');
        expect(text, `${purpose}.${version}`).toContain('ไม่มีการบันทึกภาพเซลฟี');
      }
    }
    // Each version names the processor CONSENT_POLICY_FACE_PROVIDER says it does (ADR 0009).
    for (const purpose of CONSENT_PURPOSES) {
      for (const version of CONSENT_POLICY_VERSIONS) {
        const text = fullText(purpose, version);
        if (CONSENT_POLICY_FACE_PROVIDER[version] === 'rekognition') {
          expect(th.consent.policies[purpose][version].points.processor).toContain(
            'Amazon Web Services',
          );
        } else {
          expect(text, `${purpose}.${version}`).not.toContain('Amazon');
          expect(text, `${purpose}.${version}`).toContain('เซิร์ฟเวอร์ของเราเอง');
        }
      }
    }
    // The face-search text states the API's result TTL instead of a literal.
    const search = th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION];
    expect(search.points.results).toContain('{ttl}');
    expect(search.points.results).not.toMatch(/\d+ ชั่วโมง/);
  });

  it('2026-11-11 names Kuala Lumpur and the transfer outside Thailand; older texts are unchanged', () => {
    for (const purpose of CONSENT_PURPOSES) {
      const current = th.consent.policies[purpose]['2026-11-11'].points;
      expect(current.processor).toContain('เซิร์ฟเวอร์ของเราเอง');
      expect(current.processor).toContain('กรุงกัวลาลัมเปอร์ ประเทศมาเลเซีย');
      expect(current.processor).toContain('เช่าจากผู้ให้บริการเซิร์ฟเวอร์');
      expect(current.processor).not.toContain('สิงคโปร์');
      expect(current.transfer).toContain('นอกประเทศไทย');
      expect(current.transfer).toContain('ประเทศมาเลเซีย');
      expect(current.transfer).toContain('มาตรา 28');
      expect(current.transfer).not.toContain('Amazon');
      // Released versions keep their text and have no transfer point.
      expect(th.consent.policies[purpose]['2026-10-29'].points.processor).toContain('สิงคโปร์');
      expect('transfer' in th.consent.policies[purpose]['2026-10-29'].points).toBe(false);
      expect('transfer' in th.consent.policies[purpose]['2026-10-25'].points).toBe(false);
    }
    expect(th.consent.policies.face_search['2026-11-11'].points.transfer).toContain('{ttl}');
  });

  it('2026-11-11b: the short face-search text, its details, and the corrected deletion text', () => {
    const search = th.consent.policies.face_search['2026-11-11b'];
    expect(search.title).toBe('ค้นหารูปของคุณด้วยใบหน้า');
    expect(Object.values(search.points)).toEqual([
      'เราใช้ภาพหน้าของคุณเพื่อค้นหารูปที่มีคุณในลิงก์นี้เท่านั้น',
      'ภาพหน้าของคุณไม่ถูกบันทึก ลบทิ้งทันทีหลังค้นหา',
      'ผลการค้นหาเก็บไว้ให้ดาวน์โหลดได้ {ttl} หลังการค้นหาครั้งล่าสุด แล้วลบเอง',
      'ประมวลผลบนเซิร์ฟเวอร์ที่เราเช่าใช้ในประเทศมาเลเซีย ไม่ส่งให้บริการวิเคราะห์ใบหน้าของบริษัทอื่น',
    ]);
    expect(search.checkbox).toBe('ยินยอมให้ใช้ภาพหน้าเพื่อค้นหารูป');
    const details = search.details;
    expect(details.sensitive).toContain('มาตรา 26');
    expect(details.processor).toContain('กรุงกัวลาลัมเปอร์ ประเทศมาเลเซีย');
    expect(details.processor).toContain('เช่าจากผู้ให้บริการเซิร์ฟเวอร์');
    expect(details.transfer).toContain('มาตรา 28');
    expect(details.transfer).toContain('นอกประเทศไทย');
    expect(details.index).toContain('ดัชนีใบหน้า');
    expect(details.index).toContain('หมดอายุตามกำหนดที่ช่างภาพตั้ง แล้วถูกลบอัตโนมัติ');
    expect(details.index).not.toMatch(/\d/);
    expect(details.backups).toBe(
      'ข้อมูลสำรองที่เราทำเองไม่รวมข้อมูลใบหน้าและถูกเข้ารหัส ส่วนผู้ให้บริการเซิร์ฟเวอร์อาจเก็บสำเนาสำรองทั้งเครื่องตามรอบของผู้ให้บริการ',
    );
    expect(details.rights).toContain('ถอนความยินยอม');
    expect(details.rights).toContain('ขอลบใบหน้าของฉัน');
    expect(details.contact).toContain('ติดต่อช่างภาพหรือผู้จัดงาน');
    // Corrections: no "only administrators" claim in the new texts.
    for (const purpose of CONSENT_PURPOSES) {
      const text = fullText(purpose, '2026-11-11b');
      expect(text, purpose).not.toContain('ผู้ดูแลระบบ');
      expect(text, purpose).toContain(
        'ข้อมูลสำรองที่เราทำเองไม่รวมข้อมูลใบหน้าและถูกเข้ารหัส ส่วนผู้ให้บริการเซิร์ฟเวอร์อาจเก็บสำเนาสำรองทั้งเครื่องตามรอบของผู้ให้บริการ',
      );
      expect(text, purpose).toContain('มาตรา 28');
      expect(text, purpose).not.toContain('สิงคโปร์');
    }
    // The 2026-11-11 texts stay as released.
    expect(th.consent.policies.face_search['2026-11-11'].points.transfer).toContain(
      'เฉพาะผู้ดูแลระบบ',
    );
  });

  it('2026-11-12 (latest): 2026-11-11b without the deletion-page pointer, with always-on indexing', () => {
    expect(LATEST_CONSENT_POLICY_VERSION).toBe('2026-11-12');
    const current = th.consent.policies.face_search['2026-11-12'];
    const previous = th.consent.policies.face_search['2026-11-11b'];
    // ADR 0015: no withdraw link on the share page, so the text doesn't promise one.
    expect(current.details.rights).toBe(
      'คุณขอให้ลบข้อมูลใบหน้าของคุณได้โดยติดต่อช่างภาพหรือผู้จัดงาน',
    );
    expect(th.consent.policies.face_deletion['2026-11-12'].points).not.toHaveProperty('withdraw');
    // ADR 0011 decision 1: indexing is automatic on upload; nobody "turns it on" or sets the expiry.
    expect(current.details.index).toBe(
      'เพื่อให้ค้นหาได้ ระบบจัดทำดัชนีใบหน้าของผู้ที่อยู่ในรูปของลิงก์นี้โดยอัตโนมัติเมื่อช่างภาพอัปโหลดรูป ดัชนีใบหน้านี้หมดอายุเมื่อไม่มีการอัปโหลดรูปใหม่ในงานนี้ครบระยะเวลาที่ระบบกำหนด แล้วถูกลบอัตโนมัติ',
    );
    expect({ ...current, details: { ...current.details, rights: '', index: '' } }).toEqual({
      ...previous,
      details: { ...previous.details, rights: '', index: '' },
    });
    for (const purpose of CONSENT_PURPOSES) {
      expect(fullText(purpose, '2026-11-12'), purpose).not.toMatch(/ช่างภาพเปิดให้|ช่างภาพตั้ง/);
    }
    // ADR 0015: the deletion text is 2026-11-11b without the withdraw point.
    const previousDeletionPoints: Record<string, string> = {
      ...th.consent.policies.face_deletion['2026-11-11b'].points,
    };
    delete previousDeletionPoints.withdraw;
    expect(th.consent.policies.face_deletion['2026-11-12']).toEqual({
      ...th.consent.policies.face_deletion['2026-11-11b'],
      points: previousDeletionPoints,
    });
    for (const purpose of CONSENT_PURPOSES) {
      expect(fullText(purpose, '2026-11-12'), purpose).not.toContain('ขอลบใบหน้าของฉัน');
    }
    // Released versions keep their text.
    expect(previous.details.rights).toContain('ขอลบใบหน้าของฉัน');
  });

  it('have the scan UI wording the spec requires', () => {
    expect(th.results.strong).toBe('ใช่คุณ');
    expect(th.results.maybe).toBe('อาจจะเป็นคุณ');
    // ADR 0012: no "not me" button on the share page.
    expect('notMe' in th.results).toBe(false);
    expect(th.faceDeletion.title).toBe('ขอลบใบหน้าของฉัน');
    expect(th.share.unavailable.title).toBe('ลิงก์นี้หมดอายุ');
    // ADR 0011: the sticky button, the results' select-all and retry.
    expect(th.share.scan).toBe('ค้นหาด้วยใบหน้า');
    expect(th.results.selectAll).toBe('เลือกทั้งหมด');
    expect(th.results.retry).toBe('ลองใหม่');
  });

  it('every literal t() key in components and pages exists', () => {
    const missing: string[] = [];
    let checked = 0;
    const known = new Set(all.map(([key]) => key));
    const prefixes = new Set(
      all.flatMap(([key]) => key.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.'))),
    );
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, 'utf8');
      // `const t = useTranslations('ns')` / `await getTranslations('ns')`
      const namespaces = new Map<string, string>();
      for (const m of code.matchAll(
        /const (\w+) = (?:await )?(?:useTranslations|getTranslations)\((?:'([\w.]+)')?\)/g,
      )) {
        namespaces.set(m[1] ?? '', m[2] ?? '');
      }
      for (const [fn, ns] of namespaces) {
        if (ns !== '' && !prefixes.has(ns))
          missing.push(`${path.relative(SRC, file)}: namespace ${ns}`);
        for (const m of code.matchAll(new RegExp(`\\b${fn}\\('([\\w.]+)'`, 'g'))) {
          const key = ns ? `${ns}.${m[1]}` : (m[1] ?? '');
          checked++;
          if (!known.has(key)) missing.push(`${path.relative(SRC, file)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // The scan must actually find the app's calls.
    expect(checked).toBeGreaterThan(50);
  });

  it('UI code has no hard-coded Thai: copy goes through next-intl', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.includes(`${path.sep}messages${path.sep}`))
      .filter((file) => /[\u0E00-\u0E7F]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
