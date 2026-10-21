import { describe, expect, it } from 'vitest';

import { isTemplateKey, maskAddress, render, TEMPLATES } from './templates.js';

describe('notification templates', () => {
  it('renders the requested locale', () => {
    const am = render('organization_created', 'am', { organizationName: 'Abebe Coffee', organizationId: 'o1' });
    expect(am.locale).toBe('am');
    expect(am.body).toContain('Abebe Coffee');
    expect(am.route).toBe('/organizations/o1');
  });

  it('falls back to English for unsupported locales', () => {
    expect(render('welcome', 'fr', { name: 'Sara' })).toMatchObject({ locale: 'en', body: 'Hi Sara, your account is ready.' });
  });

  it('has every template in both languages', () => {
    for (const template of Object.values(TEMPLATES)) {
      expect(Object.keys(template.text).sort()).toEqual(['am', 'en']);
    }
  });

  it('marks link-carrying templates as sensitive and never pushes them', () => {
    for (const key of ['email_verification', 'password_reset', 'organization_invitation'] as const) {
      expect(render(key, 'en', { link: 'https://x', name: 'a', organizationName: 'o', inviterName: 'i', role: 'r' })).toMatchObject({
        sensitive: true,
        push: false,
      });
    }
  });

  it('rejects unknown template keys', () => {
    expect(isTemplateKey('password_reset')).toBe(true);
    expect(isTemplateKey('__proto__')).toBe(false);
    expect(isTemplateKey('toString')).toBe(false);
  });
});

describe('maskAddress', () => {
  it('masks emails and phones', () => {
    expect(maskAddress('bereket@example.com')).toBe('b***@example.com');
    expect(maskAddress('+251911234567')).toBe('+2519****67');
  });
});
