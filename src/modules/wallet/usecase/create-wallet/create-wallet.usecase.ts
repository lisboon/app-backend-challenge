import { Money } from '../../../@shared/domain/money';
import { OutboxMessage } from '../../../@shared/domain/outbox/outbox-message.entity';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import type { OutboxGateway } from '../../../@shared/gateway/outbox.gateway';
import { Wallet } from '../../domain/wallet.entity';
import { WalletBalanceChanged } from '../../event/wallet-balance-changed.event';
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
    private readonly outbox: OutboxGateway,
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
        const processedEventId = this.ids.next();
        await this.openings.create(
          {
            eventContext: {
              eventId: processedEventId,
              correlationId: input.correlationId,
              occurredAt: at,
            },
            id: openingEntry.transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: openingEntry.money,
            at,
          },
          trx,
        );
        await this.ledger.create(openingEntry, trx);
        await this.outbox.create(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              eventId: this.ids.next(),
              correlationId: input.correlationId,
              causationId: processedEventId,
              occurredAt: at,
            }),
          ),
          trx,
        );
      }
    });

    return toWalletOutput(wallet);
  }
}
