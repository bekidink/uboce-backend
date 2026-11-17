import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { decideMatch, fingerprint, newPaymentCode, parseStatementCsv, paymentCodesIn } from './matching.js';

const D = (v: string) => new Prisma.Decimal(v);

describe('payment codes', () => {
  it('are found in noisy references and reject a typo', () => {
    const code = newPaymentCode();
    expect(code).toMatch(/^UB[0-9A-Z]{8}$/);
    expect(paymentCodesIn(`TRF FROM ABEBE ${code.slice(0, 5)}-${code.slice(5).toLowerCase()} THANKS`)).toEqual([code]);
    const typo = code.slice(0, 4) + (code[4] === '2' ? '3' : '2') + code.slice(5);
    expect(paymentCodesIn(typo)).toEqual([]);
  });
});

describe('statement CSV', () => {
  it('reads credits with quoted fields and thousands separators, skipping debits', () => {
    const csv = 'Date;Narration;Credit;Payer\n2026-11-10;"Pay INV-2026-000042; thanks";"1,250.50";Abebe\n2026-11-10;Fee;-12;Bank\nbad;row;x;y';
    const { lines, skipped } = parseStatementCsv(csv, 'ETB');
    expect(lines).toEqual([{ bookedAt: '2026-11-10T00:00:00.000Z', amount: '1250.50', currency: 'ETB', reference: 'Pay INV-2026-000042; thanks', counterparty: 'Abebe', description: undefined }]);
    expect(skipped).toBe(2);
  });

  it('fingerprints ignore formatting differences', () => {
    const a = { bookedAt: '2026-11-10', amount: '100', currency: 'etb', reference: 'X ' };
    const b = { bookedAt: '2026-11-10T08:00:00Z', amount: '100.00', currency: 'ETB', reference: 'X' };
    expect(fingerprint('CBE 1000', a)).toBe(fingerprint('cbe 1000 ', b));
  });
});

describe('automatic matching', () => {
  const inv = { id: 'i1', number: 'INV-2026-000042', paymentCode: 'UB0000000' + '0', currency: 'ETB', outstanding: D('500'), issuedAt: new Date('2026-11-01') };
  const line = (amount: string, reference = 'INV-2026-000042') => ({ bookedAt: '2026-11-05', amount, currency: 'ETB', reference });

  it('matches exact amounts on a named invoice', () => {
    expect(decideMatch(line('500.00'), [inv])).toMatchObject({ kind: 'match', invoiceId: 'i1' });
  });

  it('queues partial and over-payments with the invoice attached', () => {
    expect(decideMatch(line('200'), [inv])).toMatchObject({ kind: 'queue', invoiceId: 'i1', note: 'partial payment of INV-2026-000042' });
    expect(decideMatch(line('900'), [inv])).toMatchObject({ kind: 'queue', invoiceId: 'i1' });
  });

  it('queues unknown references and lines booked before issue', () => {
    expect(decideMatch(line('500', 'rent'), [inv])).toMatchObject({ kind: 'queue', invoiceId: null });
    expect(decideMatch({ ...line('500'), bookedAt: '2026-10-01' }, [inv])).toMatchObject({ kind: 'queue', note: 'booked before the invoice was issued' });
  });
});
