import { describe, expect, it } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../../../src/modules/@shared/domain/errors/money.errors';
import { Money } from '../../../src/modules/@shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const TOP = '999999999999999999.99';

describe('Money: entradas inválidas', () => {
  it.each([
    ['string vazia', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica minúscula', '1e5'],
    ['notação científica maiúscula', '1E5'],
    ['notação científica com sinal', '1.5e-3'],
    ['sem casas decimais', '25'],
    ['uma casa decimal', '25.5'],
    ['três casas decimais', '25.123'],
    ['zero à esquerda', '0025.00'],
    ['zero duplo', '00.00'],
    ['negativo', '-25.00'],
    ['zero negativo', '-0.00'],
    ['texto', 'vinte e cinco'],
    ['ponto sem decimal', '25.'],
    ['decimal sem inteiro', '.50'],
    ['espaço à esquerda', ' 25.00'],
    ['espaço à direita', '25.00 '],
    ['sinal de mais', '+25.00'],
    ['separador de milhar', '1,000.00'],
    ['vírgula decimal', '25,00'],
    ['hexadecimal', '0x19'],
    ['dígito não ASCII', '２５.００'],
  ])('rejeita %s', (_caso, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita number, porque JSON com number já perdeu a precisão', () => {
    expect(() => Money.from({ amount: 25 as never, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'ao'],
    ['number', 10],
    ['array', []],
  ])('rejeita props %s com erro de domínio, não TypeError', (_caso, props) => {
    expect(() => Money.from(props as never)).toThrow(InvalidMoneyError);
  });

  it('não coloca o valor recebido na mensagem do erro', () => {
    try {
      Money.from({ amount: '1234567.891', currency: 'BRL' });
      throw new Error('deveria ter lançado');
    } catch (error) {
      const invalid = error as InvalidMoneyError;

      expect(invalid).toBeInstanceOf(InvalidMoneyError);
      expect(invalid.message).not.toContain('1234567.891');
      expect(invalid.received).toBe('1234567.891');
    }
  });

  it('não coloca a moeda recebida na mensagem do erro', () => {
    try {
      Money.from({ amount: '1.00', currency: 'xpto' });
      throw new Error('deveria ter lançado');
    } catch (error) {
      const invalid = error as InvalidCurrencyError;

      expect(invalid.message).not.toContain('xpto');
      expect(invalid.received).toBe('xpto');
    }
  });

  it.each([
    ['vazia', ''],
    ['minúscula', 'brl'],
    ['duas letras', 'BR'],
    ['quatro letras', 'BRLX'],
    ['com dígito', 'BR1'],
  ])('rejeita moeda %s', (_caso, currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(
      InvalidCurrencyError,
    );
  });
});

describe('Money: entradas válidas', () => {
  it.each([
    ['zero', '0.00'],
    ['centavo', '0.01'],
    ['valor comum', '25.00'],
    ['máximo da faixa', TOP],
  ])('aceita %s e serializa igual à entrada', (_caso, amount) => {
    expect(brl(amount).toString()).toBe(amount);
  });

  it('recusa mais de dezoito dígitos inteiros em vez de arredondar', () => {
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
  });

  it('serializa como string decimal e moeda', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});

describe('Money: aritmética exata', () => {
  it('soma frações sem erro binário', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('não acumula erro ao somar dez centavos dez vezes', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10; i += 1) {
      total = total.add(brl('0.10'));
    }
    expect(total.toString()).toBe('1.00');
  });

  it('subtrai', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('subtração pode ficar negativa: quem decide se aceita é o agregado', () => {
    const result = brl('80.00').subtract(brl('100.00'));

    expect(result.toString()).toBe('-20.00');
    expect(result.isNegative()).toBe(true);
  });

  it('soma e subtrai no limite da faixa sem arredondar', () => {
    expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(TOP);
    expect(brl(TOP).subtract(brl('0.01')).toString()).toBe(
      '999999999999999999.98',
    );
  });

  it('soma de unidades em valor grande preserva o centavo', () => {
    let total = brl('999999999999999990.00');
    for (let i = 0; i < 9; i += 1) {
      total = total.add(brl('1.00'));
    }
    expect(total.toString()).toBe('999999999999999999.00');
  });

  it('recusa soma que estoura a faixa em vez de devolver valor impersistível', () => {
    expect(() => brl(TOP).add(brl(TOP))).toThrow(MoneyOverflowError);
    expect(() => brl(TOP).add(brl('0.01'))).toThrow(MoneyOverflowError);
  });

  it('recusa subtração que estoura a faixa no negativo', () => {
    expect(() => brl(TOP).negate().subtract(brl('0.01'))).toThrow(
      MoneyOverflowError,
    );
  });

  it('negar não estoura, porque a magnitude não muda', () => {
    expect(brl(TOP).negate().toString()).toBe(`-${TOP}`);
  });

  it('negar zero continua sendo zero, não negativo', () => {
    const negatedZero = Money.zero('BRL').negate();

    expect(negatedZero.toString()).toBe('0.00');
    expect(negatedZero.isNegative()).toBe(false);
    expect(negatedZero.isZero()).toBe(true);
    expect(negatedZero.equals(Money.zero('BRL'))).toBe(true);
  });

  it('é imutável: operação devolve nova instância', () => {
    const original = brl('100.00');
    const somado = original.add(brl('1.00'));

    expect(original.toString()).toBe('100.00');
    expect(somado).not.toBe(original);
  });
});

describe('Money: comparação', () => {
  it('classifica sinal', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
  });

  it('compara ordem', () => {
    expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
  });

  it('canAdd aceita a soma no limite e recusa a que o excede, sem lançar', () => {
    const max = brl('999999999999999999.98');
    expect(max.canAdd(brl('0.01'))).toBe(true);
    expect(max.canAdd(brl('0.02'))).toBe(false);
  });

  it('considera iguais quantias de mesmo valor obtidas por caminhos diferentes', () => {
    expect(brl('10.00').add(brl('15.00')).equals(brl('25.00'))).toBe(true);
  });
});

describe('Money: conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  it.each([
    ['add', (m: Money) => m.add(usd)],
    ['subtract', (m: Money) => m.subtract(usd)],
    ['isLessThan', (m: Money) => m.isLessThan(usd)],
    ['canAdd', (m: Money) => m.canAdd(usd)],
  ])('%s entre moedas diferentes falha em vez de converter', (_nome, op) => {
    expect(() => op(brl('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('equals devolve falso em vez de lançar, porque comparar é pergunta válida', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  it('zero de moedas diferentes não é igual', () => {
    expect(Money.zero('BRL').equals(Money.zero('USD'))).toBe(false);
  });
});
