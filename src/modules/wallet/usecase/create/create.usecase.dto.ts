import type { MoneyProps } from '../../../@shared/domain/money';
import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type { WalletOutputDto } from '../wallet.output.dto';

export interface CreateWalletUseCaseInputDto {
  correlationId: string;
  playerId: string;
  initialBalance: MoneyProps;
}

export type CreateWalletUseCaseOutputDto = WalletOutputDto;

export type CreateWalletUseCaseInterface = BaseUseCase<
  CreateWalletUseCaseInputDto,
  CreateWalletUseCaseOutputDto
>;
