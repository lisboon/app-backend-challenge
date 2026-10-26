import { describe, expect, it } from 'bun:test';

import { dispositionOfFailure } from '../../../src/infra/worker/message-disposition';
import { DomainError } from '../../../src/modules/@shared/domain/errors/domain.error';
import {
  DuplicateMessageError,
  MessageIdPayloadConflictError,
} from '../../../src/modules/@shared/domain/errors/inbox.errors';
import { InfrastructureUnavailableError } from '../../../src/modules/@shared/domain/errors/infrastructure.errors';
import { WalletNotFoundError } from '../../../src/modules/@shared/domain/errors/wallet-not-found.error';
import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';
import {
  IdempotencyPayloadConflictError,
  TransactionKindNotSubmittableError,
} from '../../../src/modules/wagering/domain/errors/wagering.errors';

class BusinessError extends DomainError {
  constructor() {
    super(FailureCode.INSUFFICIENT_BALANCE, 'regra');
  }
}

describe('dispositionOfFailure', () => {
  it('duplicata da inbox é confirmada sem novo efeito', () => {
    expect(dispositionOfFailure(new DuplicateMessageError())).toEqual({
      action: 'acknowledge',
      reason: 'duplicate',
    });
  });

  it('falha transitória volta para a fila', () => {
    expect(
      dispositionOfFailure(new InfrastructureUnavailableError('PostgreSQL')),
    ).toEqual({ action: 'retry' });
  });

  it.each([
    ['contrato', new TransactionKindNotSubmittableError()],
    ['conflito de idempotência', new IdempotencyPayloadConflictError()],
    ['conflito de messageId', new MessageIdPayloadConflictError()],
    ['recurso inexistente', new WalletNotFoundError()],
    ['negócio lançado em vez de gravado', new BusinessError()],
  ])('%s vai para a DLQ com o próprio código', (_caso, error) => {
    expect(dispositionOfFailure(error)).toEqual({
      action: 'dead-letter',
      failureCode: error.failureCode,
    });
  });

  it.each([new Error('invariante'), 'texto', undefined])(
    'erro interno vai para a DLQ como INTERNAL_ERROR: %p',
    (error) => {
      expect(dispositionOfFailure(error)).toEqual({
        action: 'dead-letter',
        failureCode: FailureCode.INTERNAL_ERROR,
      });
    },
  );
});
