import { Money } from '../../../@shared/domain/money';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../../../wagering/gateway/wager-transaction.gateway';
import { Wallet } from '../../domain/wallet.entity';
import type { LedgerGateway } from '../../gateway/ledger.gateway';
import type { WalletGateway } from '../../gateway/wallet.gateway';
import { toWalletOutput } from '../wallet.output.dto';
import type {
  CreateWalletUseCaseInputDto,
  CreateWalletUseCaseInterface,
  CreateWalletUseCaseOutputDto,
} from './create-wallet.usecase.dto';

export class CreateWalletUseCase implements CreateWalletUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wallets: WalletGateway,
    private readonly ledger: LedgerGateway,
    private readonly wagerTransactions: WagerTransactionGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: CreateWalletUseCaseInputDto,
  ): Promise<CreateWalletUseCaseOutputDto> {
    const at = this.clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: input.playerId,
      initialBalance: Money.from(input.initialBalance),
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at,
    });

    await this.transactions.execute(async (trx) => {
      await this.wallets.create(wallet, trx);
      if (openingEntry) {
        const opening = WagerTransaction.opening({
          id: openingEntry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: openingEntry.money,
          at,
        });
        await this.wagerTransactions.create(opening, trx);
        await this.ledger.create(openingEntry, trx);
      }
    });

    return toWalletOutput(wallet);
  }
}
