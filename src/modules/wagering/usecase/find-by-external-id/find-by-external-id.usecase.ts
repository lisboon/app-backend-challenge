import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import { TransactionNotFoundError } from '../../domain/errors/wagering.errors';
import type { WagerTransactionGateway } from '../../gateway/wager-transaction.gateway';
import { toWagerTransactionOutput } from '../wager-transaction.output.dto';
import type {
  FindWagerTransactionByExternalIdUseCaseInputDto,
  FindWagerTransactionByExternalIdUseCaseInterface,
  FindWagerTransactionByExternalIdUseCaseOutputDto,
} from './find-by-external-id.usecase.dto';

export class FindWagerTransactionByExternalIdUseCase implements FindWagerTransactionByExternalIdUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
  ) {}

  async execute(
    input: FindWagerTransactionByExternalIdUseCaseInputDto,
  ): Promise<FindWagerTransactionByExternalIdUseCaseOutputDto> {
    const transaction = await this.transactions.execute((trx) =>
      this.wagers.findByExternalId(
        input.providerId,
        input.externalTransactionId,
        trx,
      ),
    );
    if (!transaction) {
      throw new TransactionNotFoundError();
    }
    return toWagerTransactionOutput(transaction);
  }
}
