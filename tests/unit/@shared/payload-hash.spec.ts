import { describe, expect, it } from 'bun:test';

import {
  canonicalJson,
  payloadHash,
} from '../../../src/modules/@shared/domain/payload-hash';

describe('payloadHash', () => {
  it('não depende da ordem das chaves, inclusive aninhadas', () => {
    const first = payloadHash({
      walletId: 'w',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const second = payloadHash({
      money: { currency: 'BRL', amount: '25.00' },
      walletId: 'w',
    });

    expect(first).toBe(second);
  });

  it('tem versão e SHA-256 em hexadecimal', () => {
    expect(payloadHash({ a: '1' })).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('muda quando um valor de negócio muda', () => {
    expect(payloadHash({ amount: '25.00' })).not.toBe(
      payloadHash({ amount: '25.01' }),
    );
  });

  it('ignora campo ausente, para undefined e omitido terem o mesmo hash', () => {
    expect(payloadHash({ a: '1', b: undefined })).toBe(payloadHash({ a: '1' }));
  });

  it('distingue null de campo ausente', () => {
    expect(payloadHash({ a: '1', b: null })).not.toBe(payloadHash({ a: '1' }));
  });

  it('preserva a ordem de listas', () => {
    expect(payloadHash({ list: ['a', 'b'] })).not.toBe(
      payloadHash({ list: ['b', 'a'] }),
    );
  });
});

describe('canonicalJson', () => {
  it('ordena chaves e escapa strings como JSON', () => {
    expect(canonicalJson({ b: 'x"y', a: [true, null] })).toBe(
      '{"a":[true,null],"b":"x\\"y"}',
    );
  });
});
