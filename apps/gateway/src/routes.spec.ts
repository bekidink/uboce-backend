import { describe, expect, it } from 'vitest';

import { isInternalPath, resolveService } from './routes.js';

describe('gateway routing', () => {
  it('routes by whole path segment', () => {
    expect(resolveService('/api/v1/auth/login')).toBe('identity');
    expect(resolveService('/api/v1/rfqs')).toBe('procurement');
    expect(resolveService('/api/v1/rfqs/123/quotations?x=1')).toBe('procurement');
    expect(resolveService('/api/v1/rfqsx')).toBeNull();
    expect(resolveService('/api/v1/unknown')).toBeNull();
  });

  it('never exposes internal routes, however they are spelled', () => {
    for (const path of [
      '/api/v1/internal/token',
      '/api/v1/INTERNAL/token',
      '/api/v1/%69nternal/token',
      '/api/v1/organizations/../internal/organizations/x',
      '/api/v1/auth/%2e%2e/internal/token',
      '/api/v1/auth/%E0%A4%A',
    ]) {
      expect(isInternalPath(path)).toBe(true);
      expect(resolveService(path)).toBeNull();
    }
  });

  it('does not block names that merely contain the word', () => {
    expect(isInternalPath('/api/v1/catalog/products/international-coffee')).toBe(false);
  });
});
