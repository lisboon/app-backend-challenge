import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import type { WalletUseCases } from '../../../modules/wallet/factory/wallet.factory';
import type { ListWalletLedgerUseCaseOutputDto } from '../../../modules/wallet/usecase/list-wallet-ledger/list-wallet-ledger.usecase.dto';
import type { ReconcileWalletUseCaseOutputDto } from '../../../modules/wallet/usecase/reconcile-wallet/reconcile-wallet.usecase.dto';
import type { WalletOutputDto } from '../../../modules/wallet/usecase/wallet.output.dto';
import { parseRequest } from '../shared/validation/parse-request';
import {
  createWalletRequest,
  ledgerQuery,
  walletIdParam,
} from './wallet.request';
import { encodeLedgerCursor } from './ledger.cursor';

interface WalletLedgerResponse {
  items: ListWalletLedgerUseCaseOutputDto['items'];
  nextCursor: string | null;
}

export const WALLET_USE_CASES = Symbol('WALLET_USE_CASES');

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
  ) {}

  @Get(':walletId/ledger')
  async listLedger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
  ): Promise<WalletLedgerResponse> {
    const id = parseRequest(walletIdParam, walletId);
    const page = parseRequest(ledgerQuery, query);
    const result = await this.useCases.listLedger.execute({
      walletId: id,
      beforeVersion: page.cursor,
      limit: page.limit,
    });
    return {
      items: result.items,
      nextCursor:
        result.nextVersion === null
          ? null
          : encodeLedgerCursor(result.nextVersion),
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconcileWalletUseCaseOutputDto> {
    return this.useCases.reconcile.execute({
      walletId: parseRequest(walletIdParam, walletId),
    });
  }

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
