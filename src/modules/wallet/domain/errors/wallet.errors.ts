import { DomainError } from '../../../@shared/domain/errors/domain.error';
import { FailureCode } from '../../../@shared/domain/failure-code';

export class WalletAlreadyExistsError extends DomainError {
  constructor() {
    super(
      FailureCode.WALLET_ALREADY_EXISTS,
      'já existe wallet para este player nesta moeda',
    );
  }
}

export class WalletNotFoundError extends DomainError {
  constructor() {
    super(FailureCode.WALLET_NOT_FOUND, 'wallet não encontrada');
  }
}

export class WalletInvariantError extends Error {
  constructor(reason: string) {
    super(`invariante da wallet violada: ${reason}`);
    this.name = 'WalletInvariantError';
  }
}
