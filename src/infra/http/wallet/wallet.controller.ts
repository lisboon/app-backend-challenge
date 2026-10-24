import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';

import type { WalletUseCases } from '../../../modules/wallet/factory/wallet.factory';
import type { WalletOutputDto } from '../../../modules/wallet/usecase/wallet.output.dto';
import { parseRequest } from '../shared/validation/parse-request';
import { createWalletRequest, walletIdParam } from './wallet.request';

export const WALLET_USE_CASES = Symbol('WALLET_USE_CASES');

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
  ) {}

  @Post()
  create(@Body() body: unknown): Promise<WalletOutputDto> {
    return this.useCases.create.execute(
      parseRequest(createWalletRequest, body),
    );
  }

  @Get(':walletId')
  findById(@Param('walletId') walletId: string): Promise<WalletOutputDto> {
    return this.useCases.findById.execute({
      id: parseRequest(walletIdParam, walletId),
    });
  }
}
