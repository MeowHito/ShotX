import { HttpException, NotFoundException } from '@nestjs/common';
import { ERROR_CODES, ERROR_HTTP_STATUS, multipartPlan } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { bearerToken } from './auth/photographer.guard';
import { loadApiConfig } from './config';
import { isUniqueViolation, pgErrorInfo } from './db/db';
import { ApiError } from './http/api-error';
import { errorResponse } from './http/exception.filter';
import { testEnv } from './testing/fakes';
import { normalizeEtag, partsFitUpload } from './upload/upload.service';

const MiB = 1024 * 1024;

describe('error responses', () => {
  it('use ERROR_HTTP_STATUS for every code', () => {
    for (const code of ERROR_CODES) {
      const { status, body } = errorResponse(new ApiError(code, 'm'));
      expect(status).toBe(ERROR_HTTP_STATUS[code]);
      expect(body).toEqual({ code, message: 'm' });
    }
  });

  it('never leak messages, stacks or SQL of unexpected errors', () => {
    const error = new Error('duplicate key value violates unique constraint "x" DETAIL: (secret)');
    const { status, body } = errorResponse(error);
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(errorResponse(new NotFoundException('Cannot GET /secret'))).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Not found' },
    });
    expect(errorResponse(new HttpException('x', 418)).body.code).toBe('INTERNAL_ERROR');
  });

  it('carry headers such as Retry-After', () => {
    const e = new ApiError('RATE_LIMITED', 'slow down', undefined, { 'Retry-After': '5' });
    expect(errorResponse(e).headers).toEqual({ 'Retry-After': '5' });
  });
});

describe('bearerToken', () => {
  it('accepts only `Bearer <jwt>`', () => {
    expect(bearerToken('Bearer a.b.c')).toBe('a.b.c');
    for (const h of [
      undefined,
      '',
      'bearer a.b.c',
      'Bearer a.b',
      'Basic xyz',
      'Bearer a.b.c extra',
    ]) {
      expect(bearerToken(h)).toBeNull();
    }
  });
});

describe('PostgreSQL errors', () => {
  it('find the SQLSTATE through Drizzle cause chains', () => {
    const pg = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'files_live_name_unique',
    });
    const wrapped = new Error('Failed query', { cause: pg });
    expect(pgErrorInfo(wrapped)).toEqual({ code: '23505', constraint: 'files_live_name_unique' });
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(isUniqueViolation(wrapped, 'other_index')).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
  });
});

describe('upload part checks', () => {
  const size = 12 * MiB;
  const parts = (sizes: number[]) => sizes.map((s, i) => ({ partNumber: i + 1, size: s }));

  it('accept exactly the configured plan', () => {
    const plan = multipartPlan(size, 5 * MiB);
    expect(plan).toEqual({ partSize: 5 * MiB, partCount: 3 });
    expect(partsFitUpload(size, 5 * MiB, parts([5 * MiB, 5 * MiB, 2 * MiB]))).toBe(true);
  });

  it('reject short, long, missing or extra parts', () => {
    expect(partsFitUpload(size, 5 * MiB, parts([5 * MiB, 5 * MiB - 1, 2 * MiB + 1]))).toBe(false);
    expect(partsFitUpload(size, 5 * MiB, parts([5 * MiB, 5 * MiB, 2 * MiB + 1]))).toBe(false);
    expect(partsFitUpload(size, 5 * MiB, parts([5 * MiB, 5 * MiB]))).toBe(false);
    expect(partsFitUpload(size, 5 * MiB, parts([5 * MiB, 5 * MiB, 2 * MiB, 1]))).toBe(false);
  });

  it('use the part size stored at init, whatever the parts suggest', () => {
    // Stored 6 MiB (e.g. UPLOAD_PART_BYTES changed since): only that plan fits.
    expect(partsFitUpload(size, 6 * MiB, parts([6 * MiB, 6 * MiB]))).toBe(true);
    expect(partsFitUpload(size, 5 * MiB, parts([6 * MiB, 6 * MiB]))).toBe(false);
    expect(partsFitUpload(size, 6 * MiB, parts([5 * MiB, 5 * MiB, 2 * MiB]))).toBe(false);
  });

  it('compare ETags with or without quotes', () => {
    expect(normalizeEtag('"abc"')).toBe('abc');
    expect(normalizeEtag('abc')).toBe('abc');
  });
});

describe('config', () => {
  it('loads everything through the shared loaders', () => {
    const config = loadApiConfig(testEnv({ PORT: '' }));
    expect(config.server.port).toBe(4000);
    expect(config.cognito?.users.issuer).toBe(
      'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_UsersPool1',
    );
    expect(config.cognito?.admins.clientId).toBe('adminclient456');
  });

  it('fails without required settings, never echoing secrets', () => {
    const env = testEnv({ CLOUDFRONT_PRIVATE_KEY: 'not-a-key-super-secret' });
    expect(() => loadApiConfig(env)).toThrow(/CLOUDFRONT_PRIVATE_KEY/);
    try {
      loadApiConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
    expect(() => loadApiConfig(testEnv({ COGNITO_ADMIN_USER_POOL_ID: '' }))).toThrow();
  });
});
