import { Money } from '../../../@shared/domain/money';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import { Wallet } from '../../domain/wallet.entity';
import type { LedgerGateway } from '../../gateway/ledger.gateway';
import type { OpeningTransactionGateway } from '../../gateway/opening-transaction.gateway';
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
    private readonly openings: OpeningTransactionGateway,
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
        await this.openings.create(
          {
            id: openingEntry.transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: openingEntry.money,
            at,
          },
          trx,
        );
        await this.ledger.create(openingEntry, trx);
      }
    });

    return toWalletOutput(wallet);
  }
}
