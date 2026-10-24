import type { MoneyProps } from '../../@shared/domain/money';
import type { Wallet } from '../domain/wallet.entity';

export interface WalletOutputDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletOutput(wallet: Wallet): WalletOutputDto {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
