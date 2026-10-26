import { FailureCode } from '../failure-code';
import { DomainError } from './domain.error';

export class WalletNotFoundError extends DomainError {
  constructor() {
    super(FailureCode.WALLET_NOT_FOUND, 'wallet não encontrada');
  }
}
