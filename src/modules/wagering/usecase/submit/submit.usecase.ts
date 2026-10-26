import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import {
  IdempotencyPayloadConflictError,
  IdempotencyRaceError,
  ReferenceAlreadyReversedError,
} from '../../domain/errors/wagering.errors';
import type { WagerTransaction } from '../../domain/wager-transaction.entity';
import type { WagerTransactionMonitor } from '../../gateway/wager-transaction-monitor.gateway';
import type { WagerTransactionGateway } from '../../gateway/wager-transaction.gateway';
import type { WalletMovementGateway } from '../../gateway/wallet-movement.gateway';
import { wagerTransactionCandidate } from '../wager-transaction-candidate';
import type { WagerTransactionSettlement } from '../wager-transaction-settlement';
import type {
  SubmitWagerTransactionUseCaseInputDto,
  SubmitWagerTransactionUseCaseInterface,
  SubmitWagerTransactionUseCaseOutputDto,
} from './submit.usecase.dto';

export class SubmitWagerTransactionUseCase implements SubmitWagerTransactionUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
    private readonly wallets: WalletMovementGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settlement: WagerTransactionSettlement,
    private readonly monitor: WagerTransactionMonitor,
  ) {}

  async execute(
    input: SubmitWagerTransactionUseCaseInputDto,
  ): Promise<SubmitWagerTransactionUseCaseOutputDto> {
    try {
      return await this.attempt(input);
    } catch (error) {
      if (
        error instanceof IdempotencyRaceError ||
        error instanceof ReferenceAlreadyReversedError
      ) {
        return this.attempt(input);
      }
      throw error;
    }
  }

  private async attempt(
    input: SubmitWagerTransactionUseCaseInputDto,
  ): Promise<SubmitWagerTransactionUseCaseOutputDto> {
    const candidate = wagerTransactionCandidate(
      input,
      this.ids.next(),
      this.clock.now(),
    );

    const { transaction, replay } = await this.transactions.execute(
      async (trx) => {
        const wallet = await this.wallets.lock(candidate.walletId, trx);
        if (!wallet) {
          throw new WalletNotFoundError();
        }
        const recorded = await this.wagers.findByIdempotencyKey(
          candidate.providerId,
          candidate.idempotencyKey,
          trx,
        );
        if (recorded) {
          if (!recorded.matchesPayload(candidate.payloadHash)) {
            throw new IdempotencyPayloadConflictError();
          }
          return { transaction: recorded, replay: true };
        }
        await this.settlement.apply(candidate, wallet, trx);
        await this.wagers.create(candidate, trx);
        return { transaction: candidate, replay: false };
      },
    );
    if (replay) {
      this.monitor.replayed(transaction);
    } else {
      this.monitor.recorded(transaction);
    }
    return toOutput(transaction, replay);
  }
}

function toOutput(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerTransactionUseCaseOutputDto {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.resultBalance?.toJSON() ?? null,
    idempotentReplay,
  };
}
