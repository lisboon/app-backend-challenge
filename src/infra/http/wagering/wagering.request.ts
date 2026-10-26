import { z } from 'zod';

import { uuid } from '../../contract/uuid.contract';
import {
  identifier,
  providerId,
} from '../../contract/wager-transaction.contract';

export const transactionIdParam = uuid;

export const providerTransactionParams = z.strictObject({
  providerId,
  externalTransactionId: identifier,
});
