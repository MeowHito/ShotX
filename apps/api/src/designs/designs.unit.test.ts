import { DESIGN_ROUTES } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { isDesignDocumentWrite } from '../http/json-body';
import { designAssetWebKey } from './design-views';

describe('design document body limit (ADR 0013)', () => {
  it('applies to POST /designs and PUT /designs/:id only', () => {
    expect(
      isDesignDocumentWrite(DESIGN_ROUTES.create.method, `/api${DESIGN_ROUTES.create.path}`),
    ).toBe(true);
    expect(isDesignDocumentWrite('PUT', '/api/designs/0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9c0d')).toBe(
      true,
    );
    for (const [method, path] of [
      ['GET', '/api/designs'],
      ['POST', '/api/designs/'],
      ['POST', '/api/designs/assets'],
      ['POST', '/api/designs/x/default'],
      ['PUT', '/api/designs/x/default'],
      ['PATCH', '/api/designs/x'],
      ['POST', '/api/designsx'],
      ['PUT', '/designs/x'],
      ['POST', '/api/shares'],
    ] as const) {
      expect(isDesignDocumentWrite(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe('design image keys', () => {
  it('serves only web.webp under the owner', () => {
    expect(
      designAssetWebKey({
        ownerId: '0195f3a2-0000-7000-8000-000000000001',
        id: '0195f3a2-0000-7000-8000-000000000002',
      }),
    ).toBe(
      'designs/0195f3a2-0000-7000-8000-000000000001/0195f3a2-0000-7000-8000-000000000002/web.webp',
    );
  });
});
