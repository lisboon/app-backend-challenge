import { DomainError } from '../../../@shared/domain/errors/domain.error';
import { FailureCode } from '../../../@shared/domain/failure-code';

export class ProviderReservedError extends DomainError {
  constructor() {
    super(
      FailureCode.PROVIDER_RESERVED,
      'o provedor internal é reservado para operações internas',
    );
  }
}

export class TransactionKindNotSubmittableError extends DomainError {
  constructor() {
    super(
      FailureCode.TRANSACTION_KIND_NOT_SUBMITTABLE,
      'OPENING é interno e não pode ser submetido',
    );
  }
}

export class TransactionAmountInvalidError extends DomainError {
  constructor() {
    super(
      FailureCode.TRANSACTION_AMOUNT_INVALID,
      'BET e WIN exigem valor maior que zero',
    );
  }
}

export class IdempotencyKeyMissingError extends DomainError {
  constructor() {
    super(
      FailureCode.IDEMPOTENCY_KEY_MISSING,
      'o header Idempotency-Key é obrigatório',
    );
  }
}

export class IdempotencyPayloadConflictError extends DomainError {
  constructor() {
    super(
      FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT,
      'a Idempotency-Key já foi usada com outro payload',
    );
  }
}

export class ExternalTransactionConflictError extends DomainError {
  constructor() {
    super(
      FailureCode.EXTERNAL_TRANSACTION_CONFLICT,
      'o externalTransactionId já foi usado com outra Idempotency-Key',
    );
  }
}

export class TransactionNotFoundError extends DomainError {
  constructor() {
    super(FailureCode.TRANSACTION_NOT_FOUND, 'transação não encontrada');
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: string) {
    super(`transação em estado terminal ${status} não pode mudar de estado`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class IdempotencyRaceError extends Error {
  constructor() {
    super('outra requisição gravou a mesma Idempotency-Key em paralelo');
    this.name = 'IdempotencyRaceError';
  }
}
