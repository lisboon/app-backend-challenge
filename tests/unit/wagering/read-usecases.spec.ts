import { describe, expect, it } from 'bun:test';

import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import { TransactionNotFoundError } from '../../../src/modules/wagering/domain/errors/wagering.errors';
import type { WagerTransactionGateway } from '../../../src/modules/wagering/gateway/wager-transaction.gateway';
import { FindWagerTransactionByExternalIdUseCase } from '../../../src/modules/wagering/usecase/find-by-external-id/find-by-external-id.usecase';
import { FindWagerTransactionByIdUseCase } from '../../../src/modules/wagering/usecase/find-by-id/find-by-id.usecase';

class FakeContext extends TransactionContext {
  constructor() {
    super();
  }
}

const readOnly: TransactionManager = {
  execute: () => {
    throw new Error('consulta abriu uma transação de escrita');
  },
  snapshot: (work) => work(new FakeContext()),
};

const wagers = {
  findById: async () => null,
  findByExternalId: async () => null,
} as unknown as WagerTransactionGateway;

describe('consultas de transação de aposta', () => {
  it('busca por id usa o snapshot de leitura', async () => {
    expect(
      await new FindWagerTransactionByIdUseCase(readOnly, wagers)
        .execute({ id: 'tx' })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(TransactionNotFoundError);
  });

  it('busca por id externo usa o snapshot de leitura', async () => {
    expect(
      await new FindWagerTransactionByExternalIdUseCase(readOnly, wagers)
        .execute({ providerId: 'provider', externalTransactionId: 'ext' })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(TransactionNotFoundError);
  });
});
