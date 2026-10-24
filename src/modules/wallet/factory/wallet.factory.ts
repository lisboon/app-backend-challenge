import type { TransactionManager } from '../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../@shared/gateway/id-generator.gateway';
import { WagerTransactionRepository } from '../../wagering/repository/wager-transaction.repository';
import { LedgerRepository } from '../repository/ledger.repository';
import { WalletRepository } from '../repository/wallet.repository';
import { CreateWalletUseCase } from '../usecase/create-wallet/create-wallet.usecase';
import { FindWalletByIdUseCase } from '../usecase/find-by-id/find-by-id.usecase';

export interface WalletFactoryDependencies {
  transactions: TransactionManager;
  ids: IdGenerator;
  clock: Clock;
}

export interface WalletUseCases {
  create: CreateWalletUseCase;
  findById: FindWalletByIdUseCase;
}

export const WalletFactory = {
  create(dependencies: WalletFactoryDependencies): WalletUseCases {
    const wallets = new WalletRepository();
    return {
      create: new CreateWalletUseCase(
        dependencies.transactions,
        wallets,
        new LedgerRepository(),
        new WagerTransactionRepository(),
        dependencies.ids,
        dependencies.clock,
      ),
      findById: new FindWalletByIdUseCase(dependencies.transactions, wallets),
    };
  },
};
