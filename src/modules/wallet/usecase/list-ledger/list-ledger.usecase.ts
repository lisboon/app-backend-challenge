import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { LedgerGateway } from '../../gateway/ledger.gateway';
import type { WalletGateway } from '../../gateway/wallet.gateway';
import type {
  ListWalletLedgerUseCaseInputDto,
  ListWalletLedgerUseCaseOutputDto,
  ListWalletLedgerUseCaseInterface,
} from './list-ledger.usecase.dto';

export class ListWalletLedgerUseCase implements ListWalletLedgerUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wallets: WalletGateway,
    private readonly ledger: LedgerGateway,
  ) {}

  execute(
    input: ListWalletLedgerUseCaseInputDto,
  ): Promise<ListWalletLedgerUseCaseOutputDto> {
    return this.transactions.execute(async (trx) => {
      const wallet = await this.wallets.findById(input.walletId, trx);
      if (!wallet) {
        throw new WalletNotFoundError();
      }
      const entries = await this.ledger.findByWallet(
        wallet.id,
        wallet.currency,
        { beforeVersion: input.beforeVersion, limit: input.limit + 1 },
        trx,
      );
      const items = entries.slice(0, input.limit).map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      }));
      return {
        items,
        nextVersion:
          entries.length > input.limit
            ? items[items.length - 1].walletVersion
            : null,
      };
    });
  }
}
