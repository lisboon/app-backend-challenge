import { describe, expect, it } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../../../src/modules/@shared/domain/errors/money.errors';
import {
  FailureCode,
  FailureKind,
  failureKindOf,
} from '../../../src/modules/@shared/domain/failure-code';

describe('taxonomia de falha', () => {
  it('mantém o código igual ao nome, para o valor não divergir da chave', () => {
    for (const [name, value] of Object.entries(FailureCode)) {
      expect<string>(value).toBe(name);
    }
  });

  it('classifica todo código, sem deixar nenhum sem natureza', () => {
    for (const code of Object.values(FailureCode)) {
      expect(Object.values(FailureKind)).toContain(failureKindOf(code));
    }
  });
});

describe('erros de Money carregam código e natureza', () => {
  it.each([
    [
      'formato de valor é contrato',
      () => new InvalidMoneyError('formato', '1.234'),
      FailureCode.MONEY_INVALID_FORMAT,
      FailureKind.CONTRACT,
    ],
    [
      'moeda inválida é contrato',
      () => new InvalidCurrencyError('xpto'),
      FailureCode.CURRENCY_INVALID,
      FailureKind.CONTRACT,
    ],
    [
      'moedas diferentes é negócio: payload válido aplicado à wallet errada',
      () => new CurrencyMismatchError('BRL', 'USD'),
      FailureCode.CURRENCY_MISMATCH,
      FailureKind.BUSINESS,
    ],
    [
      'estouro de faixa é negócio: só nasce de aritmética sobre saldo',
      () => new MoneyOverflowError(18),
      FailureCode.MONEY_OUT_OF_RANGE,
      FailureKind.BUSINESS,
    ],
  ])('%s', (_caso, build, expectedCode, expectedKind) => {
    const error = build();

    expect(error.failureCode).toBe(expectedCode);
    expect(error.failureKind).toBe(expectedKind);
    expect(error.name).toBe(error.constructor.name);
  });
});
