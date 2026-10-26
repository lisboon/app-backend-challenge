import { Counter, Registry } from 'prom-client';

import type { LockConflictReason } from '../database/database-errors';
import type { LockConflictMonitor } from '../database/mikro-orm-transaction-manager';

export class PrometheusLockConflictMonitor implements LockConflictMonitor {
  private readonly conflicts: Counter<'reason'>;

  constructor(registry: Registry) {
    this.conflicts = new Counter({
      name: 'lock_conflicts_total',
      help: 'Transações desfeitas por timeout de lock, deadlock ou serialização',
      labelNames: ['reason'],
      registers: [registry],
    });
  }

  conflict(reason: LockConflictReason): void {
    this.conflicts.inc({ reason });
  }
}
