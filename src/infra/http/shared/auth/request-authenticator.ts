import type { Request } from 'express';

export const REQUEST_AUTHENTICATOR = Symbol('REQUEST_AUTHENTICATOR');

export interface RequestAuthenticator {
  authenticate(request: Request): Promise<boolean>;
}

export class AnonymousAuthenticator implements RequestAuthenticator {
  authenticate(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
