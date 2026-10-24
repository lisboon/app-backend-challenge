import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import { Money } from '../../../@shared/domain/money';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { Clock } from '../../../@shared/gateway/clock.gateway';
import type { IdGenerator } from '../../../@shared/gateway/id-generator.gateway';
import {
  IdempotencyPayloadConflictError,
  IdempotencyRaceError,
} from '../../domain/errors/wagering.errors';
import { WagerTransaction } from '../../domain/wager-transaction.entity';
import type { WagerTransactionGateway } from '../../gateway/wager-transaction.gateway';
import type {
  LockedWallet,
  WalletMovementGateway,
} from '../../gateway/wallet-movement.gateway';
import type {
  SubmitWagerTransactionUseCaseInputDto,
  SubmitWagerTransactionUseCaseInterface,
  SubmitWagerTransactionUseCaseOutputDto,
} from './submit-wager-transaction.usecase.dto';

export class SubmitWagerTransactionUseCase implements SubmitWagerTransactionUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
    private readonly wallets: WalletMovementGateway,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: SubmitWagerTransactionUseCaseInputDto,
  ): Promise<SubmitWagerTransactionUseCaseOutputDto> {
    try {
      return await this.attempt(input);
    } catch (error) {
      if (error instanceof IdempotencyRaceError) {
        return this.attempt(input);
      }
      throw error;
    }
  }

  private attempt(
    input: SubmitWagerTransactionUseCaseInputDto,
  ): Promise<SubmitWagerTransactionUseCaseOutputDto> {
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: Money.from(input.money),
      at: this.clock.now(),
    });

    return this.transactions.execute(async (trx) => {
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
        return this.replay(recorded, candidate);
      }
      await this.settle(candidate, wallet);
      await this.wagers.create(candidate, trx);
      return toOutput(candidate, false);
    });
  }

  private replay(
    recorded: WagerTransaction,
    candidate: WagerTransaction,
  ): SubmitWagerTransactionUseCaseOutputDto {
    if (!recorded.matchesPayload(candidate.payloadHash)) {
      throw new IdempotencyPayloadConflictError();
    }
    return toOutput(recorded, true);
  }

  private async settle(
    candidate: WagerTransaction,
    wallet: LockedWallet,
  ): Promise<void> {
    const at = candidate.createdAt;
    const rejection = candidate.rejectionFor(wallet);
    if (rejection) {
      candidate.reject(rejection, wallet.balance, at);
      return;
    }
    const balance = candidate.affectsBalance()
      ? await wallet.apply({
          transactionId: candidate.id,
          entryId: this.ids.next(),
          direction: candidate.ledgerDirectionFor(),
          money: candidate.money,
          at,
        })
      : wallet.balance;
    candidate.markProcessed(balance, at);
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
