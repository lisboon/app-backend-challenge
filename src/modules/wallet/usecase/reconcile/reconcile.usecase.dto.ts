import type { MoneyProps } from '../../../@shared/domain/money';
import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';

export interface ReconcileWalletUseCaseInputDto {
  walletId: string;
}
export interface ReconcileWalletUseCaseOutputDto {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
export type ReconcileWalletUseCaseInterface = BaseUseCase<
  ReconcileWalletUseCaseInputDto,
  ReconcileWalletUseCaseOutputDto
>;
