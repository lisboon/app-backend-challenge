import { describe, expect, it } from 'bun:test';

import { WalletNotFoundError } from '../../../src/modules/@shared/domain/errors/wallet-not-found.error';
import {
  TransactionContext,
  type TransactionManager,
} from '../../../src/modules/@shared/domain/transaction/transaction-manager';
import type { LedgerGateway } from '../../../src/modules/wallet/gateway/ledger.gateway';
import type { WalletGateway } from '../../../src/modules/wallet/gateway/wallet.gateway';
import { FindWalletByIdUseCase } from '../../../src/modules/wallet/usecase/find-by-id/find-by-id.usecase';
import { ListWalletLedgerUseCase } from '../../../src/modules/wallet/usecase/list-ledger/list-ledger.usecase';

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

const wallets = { findById: async () => null } as unknown as WalletGateway;

describe('consultas de wallet', () => {
  it('busca por id usa o snapshot de leitura', async () => {
    expect(
      await new FindWalletByIdUseCase(readOnly, wallets)
        .execute({ id: 'wallet' })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(WalletNotFoundError);
  });

  it('extrato lê wallet e lançamentos no mesmo snapshot de leitura', async () => {
    expect(
      await new ListWalletLedgerUseCase(readOnly, wallets, {} as LedgerGateway)
        .execute({ walletId: 'wallet', limit: 10 })
        .catch((error: unknown) => error),
    ).toBeInstanceOf(WalletNotFoundError);
  });
});
