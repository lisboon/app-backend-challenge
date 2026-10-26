import { describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { Registry } from 'prom-client';

import { PrometheusWagerConsumerMonitor } from '../../../src/infra/observability/wager-consumer-monitor';
import type { WagerQueue } from '../../../src/infra/queue/wager-queue';
import { FailureCode } from '../../../src/modules/@shared/domain/failure-code';

const queueWithDepth = (depth: () => Promise<number>): WagerQueue =>
  ({ deadLetterDepth: depth }) as unknown as WagerQueue;

describe('PrometheusWagerConsumerMonitor', () => {
  it('separa processado, duplicata, retry e DLQ por desfecho', async () => {
    const registry = new Registry();
    const monitor = new PrometheusWagerConsumerMonitor(
      registry,
      queueWithDepth(async () => 0),
    );

    monitor.handled({ action: 'acknowledge', reason: 'processed' }, 0.02);
    monitor.handled({ action: 'acknowledge', reason: 'duplicate' }, 0.01);
    monitor.handled({ action: 'retry' }, 0.5);
    monitor.handled(
      { action: 'dead-letter', failureCode: FailureCode.MESSAGE_INVALID },
      0.01,
    );

    const metrics = await registry.metrics();
    for (const series of [
      'wager_message_processing_seconds_count{outcome="processed"} 1',
      'wager_message_processing_seconds_count{outcome="duplicate"} 1',
      'wager_message_processing_seconds_count{outcome="retry"} 1',
      'wager_message_processing_seconds_count{outcome="dead-letter"} 1',
      'inbox_duplicates_total 1',
      'wager_message_retries_total 1',
      'wager_messages_dead_lettered_total{failure_code="MESSAGE_INVALID"} 1',
    ]) {
      expect(metrics).toContain(series);
    }
  });

  it('SQS fora na coleta mantém o último valor da DLQ e não derruba as métricas', async () => {
    const registry = new Registry();
    let available = true;
    new PrometheusWagerConsumerMonitor(
      registry,
      queueWithDepth(async () => {
        if (!available) {
          throw new Error('sqs indisponível');
        }
        return 3;
      }),
    );
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      expect(await registry.metrics()).toContain('wager_dlq_messages 3');
      available = false;

      const metrics = await registry.metrics();

      expect(metrics).toContain('wager_dlq_messages 3');
      expect(metrics).toContain('wager_message_retries_total 0');
      expect(warn).toHaveBeenCalledWith({
        event: 'wager_dlq_depth_unavailable',
      });
    } finally {
      warn.mockRestore();
    }
  });
});
