import { FailureCode } from '../failure-code';
import { DomainError } from './domain.error';

export class InvalidMoneyError extends DomainError {
  readonly reason: string;
  readonly received: unknown;

  constructor(reason: string, received: unknown) {
    super(
      FailureCode.MONEY_INVALID_FORMAT,
      `valor monetário inválido: ${reason}`,
    );
    this.reason = reason;
    this.received = received;
  }
}

export class InvalidCurrencyError extends DomainError {
  readonly received: unknown;

  constructor(received: unknown) {
    super(
      FailureCode.CURRENCY_INVALID,
      'moeda inválida: esperado código ISO-4217 de três letras maiúsculas',
    );
    this.received = received;
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(
      FailureCode.CURRENCY_MISMATCH,
      `operação entre moedas diferentes: ${left} e ${right}`,
    );
  }
}

export class MoneyOverflowError extends DomainError {
  constructor(readonly maxIntegerDigits: number) {
    super(
      FailureCode.MONEY_OUT_OF_RANGE,
      `resultado excede a faixa representável de ${maxIntegerDigits} dígitos inteiros`,
    );
  }
}
