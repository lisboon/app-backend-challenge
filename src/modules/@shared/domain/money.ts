import { Decimal as GlobalDecimal } from 'decimal.js';

import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyError,
  MoneyOverflowError,
} from './errors/money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;

const MAX_INTEGER_DIGITS = 18;

const Decimal = GlobalDecimal.clone({
  precision: 40,
  rounding: GlobalDecimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});

type DecimalValue = InstanceType<typeof Decimal>;

const DECIMAL_STRING = new RegExp(
  `^(0|[1-9]\\d{0,${MAX_INTEGER_DIGITS - 1}})\\.\\d{${SCALE}}$`,
);

const ISO_4217 = /^[A-Z]{3}$/;

const MAX_MAGNITUDE = new Decimal(10).pow(MAX_INTEGER_DIGITS);

export class Money {
  private constructor(
    private readonly value: DecimalValue,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('esperado objeto com valor e moeda', props);
    }
    return Money.of(
      Money.parseAmount(props.amount),
      Money.parseCurrency(props.currency),
    );
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static of(value: DecimalValue, currency: string): Money {
    if (value.abs().greaterThanOrEqualTo(MAX_MAGNITUDE)) {
      throw new MoneyOverflowError(MAX_INTEGER_DIGITS);
    }
    return new Money(value, currency);
  }

  private static parseAmount(amount: string): DecimalValue {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('esperado string decimal', amount);
    }
    if (!DECIMAL_STRING.test(amount)) {
      throw new InvalidMoneyError(
        `formato deve ser decimal não negativo com até ${MAX_INTEGER_DIGITS} dígitos inteiros e exatamente ${SCALE} casas`,
        amount,
      );
    }
    return new Decimal(amount);
  }

  private static parseCurrency(currency: string): string {
    if (typeof currency !== 'string' || !ISO_4217.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
    return currency;
  }
}
