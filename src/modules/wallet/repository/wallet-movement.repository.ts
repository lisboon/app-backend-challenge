import type { Money } from '../../@shared/domain/money';
import type { TransactionContext } from '../../@shared/domain/transaction/transaction-manager';
import { MovementDirection } from '../../wagering/domain/wager-transaction.entity';
import type {
  LockedWallet,
  WalletMovement,
  WalletMovementGateway,
} from '../../wagering/gateway/wallet-movement.gateway';
import type { Wallet } from '../domain/wallet.entity';
import type { LedgerGateway } from '../gateway/ledger.gateway';
import type { WalletGateway } from '../gateway/wallet.gateway';

export class WalletMovementRepository implements WalletMovementGateway {
  constructor(
    private readonly wallets: WalletGateway,
    private readonly ledger: LedgerGateway,
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
  ): Promise<Money> {
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
    return wallet.balance;
  }
}
