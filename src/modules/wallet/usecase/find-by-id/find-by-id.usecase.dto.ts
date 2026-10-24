import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';
import type { WalletOutputDto } from '../wallet.output.dto';

export interface FindWalletByIdUseCaseInputDto {
  id: string;
}

export type FindWalletByIdUseCaseOutputDto = WalletOutputDto;

export type FindWalletByIdUseCaseInterface = BaseUseCase<
  FindWalletByIdUseCaseInputDto,
  FindWalletByIdUseCaseOutputDto
>;
