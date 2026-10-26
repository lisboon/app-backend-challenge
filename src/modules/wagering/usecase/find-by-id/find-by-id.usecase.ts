import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import { TransactionNotFoundError } from '../../domain/errors/wagering.errors';
import type { WagerTransactionGateway } from '../../gateway/wager-transaction.gateway';
import { toWagerTransactionOutput } from '../wager-transaction.output.dto';
import type {
  FindWagerTransactionByIdUseCaseInputDto,
  FindWagerTransactionByIdUseCaseInterface,
  FindWagerTransactionByIdUseCaseOutputDto,
} from './find-by-id.usecase.dto';

export class FindWagerTransactionByIdUseCase implements FindWagerTransactionByIdUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wagers: WagerTransactionGateway,
  ) {}

  async execute(
    input: FindWagerTransactionByIdUseCaseInputDto,
  ): Promise<FindWagerTransactionByIdUseCaseOutputDto> {
    const transaction = await this.transactions.snapshot((trx) =>
      this.wagers.findById(input.id, trx),
    );
    if (!transaction) {
      throw new TransactionNotFoundError();
    }
    return toWagerTransactionOutput(transaction);
  }
}
