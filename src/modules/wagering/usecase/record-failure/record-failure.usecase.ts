import { FailureCode } from '../../../@shared/domain/failure-code';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import type { WagerTransactionMonitor } from '../../gateway/wager-transaction-monitor.gateway';
import type { WagerTransactionGateway } from '../../gateway/wager-transaction.gateway';
import type { WalletMovementGateway } from '../../gateway/wallet-movement.gateway';
import { wagerTransactionCandidate } from '../wager-transaction-candidate';
import type {
  RecordFailedWagerTransactionUseCaseInputDto,
  RecordFailedWagerTransactionUseCaseInterface,
  RecordFailedWagerTransactionUseCaseOutputDto,
} from './record-failure.usecase.dto';

export class RecordFailedWagerTransactionUseCase implements RecordFailedWagerTransactionUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
    private readonly wallets: WalletMovementGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly monitor: WagerTransactionMonitor,
  ) {}

  async execute(
    input: RecordFailedWagerTransactionUseCaseInputDto,
  ): Promise<RecordFailedWagerTransactionUseCaseOutputDto> {
    const candidate = wagerTransactionCandidate(
      input,
      this.ids.next(),
      this.clock.now(),
    );
    const recorded = await this.transactions.execute(async (trx) => {
      const wallet = await this.wallets.lock(candidate.walletId, trx);
      const existing = await this.wagers.findByIdempotencyKey(
        candidate.providerId,
        candidate.idempotencyKey,
        trx,
      );
      if (!wallet || existing) {
        return false;
      }
      candidate.fail(FailureCode.PROCESSING_FAILED, this.clock.now());
      await this.wagers.create(candidate, trx);
      return true;
    });
    if (!recorded) {
      return { transactionId: null };
    }
    this.monitor.recorded(candidate);
    return { transactionId: candidate.id };
  }
}
