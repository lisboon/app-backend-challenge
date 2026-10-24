export abstract class TransactionContext {
  protected constructor() {}
}

export interface TransactionManager {
  snapshot<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T>;
  execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T>;
}
