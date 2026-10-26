import type { MoneyProps } from '../../../@shared/domain/money';
import type { BaseUseCase } from '../../../@shared/usecase/base.usecase';

export interface ListWalletLedgerUseCaseInputDto {
  walletId: string;
  beforeVersion?: number;
  limit: number;
}
interface LedgerEntryOutputDto {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}
export interface ListWalletLedgerUseCaseOutputDto {
  items: LedgerEntryOutputDto[];
  nextVersion: number | null;
}
export type ListWalletLedgerUseCaseInterface = BaseUseCase<
  ListWalletLedgerUseCaseInputDto,
  ListWalletLedgerUseCaseOutputDto
>;
