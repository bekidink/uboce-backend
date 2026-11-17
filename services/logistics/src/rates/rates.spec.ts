import { describe, expect, it } from 'vitest';

import { deliveryFee } from './rates.js';

const card = {
  freeOverAmount: '5000',
  zones: [
    { name: 'Addis Ababa', areas: ['Addis Ababa', 'Finfinne'], baseFee: '100', perKgFee: '2.5', maxWeightKg: '500' },
    { name: 'Elsewhere', areas: ['*'], baseFee: '400', perKgFee: '5' },
  ],
};

describe('deliveryFee', () => {
  it('charges base plus weight in the matching zone', () => {
    expect(deliveryFee(card, { goodsAmount: '1000', weightKg: '10', city: ' addis ababa ' })).toEqual({ ok: true, zone: 'Addis Ababa', fee: '125.00', freeDelivery: false });
  });

  it('falls back to the catch-all zone and matches regions too', () => {
    expect(deliveryFee(card, { goodsAmount: '1000', weightKg: '1', city: 'Adama', region: 'Oromia' })).toMatchObject({ zone: 'Elsewhere', fee: '405.00' });
  });

  it('is free over the threshold', () => {
    expect(deliveryFee(card, { goodsAmount: '5000', weightKg: '10', city: 'Addis Ababa' })).toMatchObject({ fee: '0.00', freeDelivery: true });
  });

  it('refuses areas it does not cover and overweight orders', () => {
    expect(deliveryFee({ ...card, zones: [card.zones[0]!] }, { goodsAmount: '1', weightKg: '1', city: 'Gondar' })).toMatchObject({ ok: false, reason: 'no_zone' });
    expect(deliveryFee(card, { goodsAmount: '1', weightKg: '600', city: 'Addis Ababa' })).toMatchObject({ ok: false, reason: 'too_heavy' });
  });
});
