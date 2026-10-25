import { WalletNotFoundError } from '../../../@shared/domain/errors/wallet-not-found.error';
import type { TransactionManager } from '../../../@shared/domain/transaction/transaction-manager';
import type { WalletGateway } from '../../gateway/wallet.gateway';
import { toWalletOutput } from '../wallet.output.dto';
import type {
  FindWalletByIdUseCaseInputDto,
  FindWalletByIdUseCaseInterface,
  FindWalletByIdUseCaseOutputDto,
} from './find-by-id.usecase.dto';

export class FindWalletByIdUseCase implements FindWalletByIdUseCaseInterface {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly wallets: WalletGateway,
  ) {}

  async execute(
    input: FindWalletByIdUseCaseInputDto,
  ): Promise<FindWalletByIdUseCaseOutputDto> {
    const wallet = await this.transactions.execute((trx) =>
      this.wallets.findById(input.id, trx),
    );
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    return toWalletOutput(wallet);
  }
}
