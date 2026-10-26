import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC } from './public.decorator';
import {
  REQUEST_AUTHENTICATOR,
  type RequestAuthenticator,
} from './request-authenticator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REQUEST_AUTHENTICATOR)
    private readonly authenticator: RequestAuthenticator,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    return isPublic
      ? Promise.resolve(true)
      : this.authenticator.authenticate(
          context.switchToHttp().getRequest<Request>(),
        );
  }
}
