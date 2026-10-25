import { OutboxMessage } from '../../@shared/domain/outbox/outbox-message.entity';
import type { OutboxGateway } from '../../@shared/gateway/outbox.gateway';
import { WalletBalanceChanged } from '../event/wallet-balance-changed.event';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { MovementDirection } from '../../wagering/domain/wager-transaction.entity';
import type {
  LockedWallet,
  WalletMovement,
  WalletMovementGateway,
  WalletMovementResult,
} from '../../wagering/gateway/wallet-movement.gateway';
import type { Wallet } from '../domain/wallet.entity';
import type { LedgerGateway } from '../gateway/ledger.gateway';
import type { WalletGateway } from '../gateway/wallet.gateway';

export class WalletMovementRepository implements WalletMovementGateway {
  constructor(
    private readonly wallets: WalletGateway,
    private readonly ledger: LedgerGateway,
    private readonly outbox: OutboxGateway,
  ) {}

  async lock(
    walletId: string,
    trx: TransactionContext,
  ): Promise<LockedWallet | null> {
    const wallet = await this.wallets.findByIdForUpdate(walletId, trx);
    if (!wallet) {
      return null;
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance,
      apply: (movement) => this.apply(wallet, movement, trx),
    };
  }

  private async apply(
    wallet: Wallet,
    movement: WalletMovement,
    trx: TransactionContext,
  ): Promise<WalletMovementResult> {
    const expectedVersion = wallet.version;
    const props = {
      entryId: movement.entryId,
      transactionId: movement.transactionId,
      money: movement.money,
      at: movement.at,
    };
    const entry =
      movement.direction === MovementDirection.Debit
        ? wallet.debit(props)
        : wallet.credit(props);
    await this.wallets.update(wallet, expectedVersion, trx);
    await this.ledger.create(entry, trx);
    return {
      balance: wallet.balance,
      recordBalanceChanged: () =>
        this.outbox.create(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, movement.eventContext),
          ),
          trx,
        ),
    };
  }
}
