export abstract class TransactionContext {
  protected constructor() {}
}

export interface TransactionManager {
  execute<T>(work: (trx: TransactionContext) => Promise<T>): Promise<T>;
}
