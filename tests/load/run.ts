import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { cpus, totalmem, type as osType, release } from 'node:os';

import {
  API_URLS,
  SQS_ENDPOINT,
  WORKER_METRICS_URLS,
  sampleValue,
  scrape,
  startStack,
  stopStack,
} from './stack';

const CONCURRENCY = 50;
const REQUESTS_PER_SCENARIO = 2000;
const WARMUP_REQUESTS = 100;
const DISTRIBUTED_WALLETS = 100;
const DUPLICATE_SHARE = 0.2;
const OVERLOAD_CONCURRENCY = 150;
const BET = { amount: '1.00', currency: 'BRL' };
const BET_CENTS = 100n;
const QUEUE_DRAIN_TIMEOUT_SECONDS = 300;
const OUTBOX_DRAIN_TIMEOUT_SECONDS = 120;

interface Wallet {
  walletId: string;
  playerId: string;
  initialCents: bigint;
  debits: number;
}

const toCents = (amount: string): bigint => BigInt(amount.replace('.', ''));

const formatCents = (cents: bigint): string =>
  `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

interface Submission {
  wallet: Wallet;
  key: string;
  body: Record<string, unknown>;
}

interface Sample {
  status: number;
  ms: number;
}

interface ScenarioResult {
  name: string;
  requests: number;
  seconds: number;
  samples: Sample[];
  replays: number;
  lockConflicts: number;
  maxOutboxLag: number;
  outboxDrainSeconds: number;
}

const uuid = (): string => Bun.randomUUIDv7();
let next = 0;
const apiUrl = (): string => API_URLS[next++ % API_URLS.length];

async function openWallet(initial: string): Promise<Wallet> {
  const playerId = uuid();
  const response = await fetch(`${apiUrl()}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initial, currency: 'BRL' },
    }),
  });
  if (response.status !== 201) {
    throw new Error(`abertura de wallet respondeu ${response.status}`);
  }
  const { id } = (await response.json()) as { id: string };
  return { walletId: id, playerId, initialCents: toCents(initial), debits: 0 };
}

function bet(wallet: Wallet): Submission {
  const externalTransactionId = uuid();
  return {
    wallet,
    key: `load:${externalTransactionId}`,
    body: {
      providerId: 'provider-load',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-load',
      gameId: 'game-load',
      kind: 'BET',
      money: BET,
    },
  };
}

async function submit(
  submission: Submission,
): Promise<Sample & { replay: boolean }> {
  const startedAt = performance.now();
  const response = await fetch(`${apiUrl()}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': submission.key,
    },
    body: JSON.stringify(submission.body),
  });
  const ms = performance.now() - startedAt;
  const payload = (await response.json()) as { idempotentReplay?: boolean };
  const replay = payload.idempotentReplay === true;
  if (response.status === 201 && !replay) {
    submission.wallet.debits += 1;
  }
  return { status: response.status, ms, replay };
}

async function inParallel<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency = CONCURRENCY,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

async function allMetrics(): Promise<string[]> {
  return Promise.all(
    [...API_URLS.map((url) => `${url}/metrics`), ...WORKER_METRICS_URLS].map(
      scrape,
    ),
  );
}

async function lockConflicts(): Promise<number> {
  return (await allMetrics()).reduce(
    (sum, metrics) => sum + sampleValue(metrics, 'lock_conflicts_total'),
    0,
  );
}

function watchOutboxLag(): { stop: () => Promise<number> } {
  let max = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const url of WORKER_METRICS_URLS) {
        max = Math.max(
          max,
          sampleValue(await scrape(url), 'outbox_lag_seconds'),
        );
      }
      await Bun.sleep(250);
    }
  })();
  loop.catch(() => undefined);
  return {
    stop: async () => {
      running = false;
      await loop;
      return max;
    },
  };
}

async function until(
  done: () => Promise<boolean>,
  timeoutSeconds: number,
  what: string,
): Promise<number> {
  const startedAt = performance.now();
  while (!(await done())) {
    if (performance.now() - startedAt > timeoutSeconds * 1000) {
      throw new Error(`${what} não terminou em ${timeoutSeconds} s`);
    }
    await Bun.sleep(100);
  }
  return (performance.now() - startedAt) / 1000;
}

function waitOutboxDrained(): Promise<number> {
  return until(
    async () =>
      (
        await Promise.all(
          WORKER_METRICS_URLS.map(async (url) =>
            sampleValue(await scrape(url), 'outbox_lag_seconds'),
          ),
        )
      ).every((lag) => lag === 0),
    OUTBOX_DRAIN_TIMEOUT_SECONDS,
    'a drenagem da outbox',
  );
}

async function httpScenario(
  name: string,
  submissions: Submission[],
  concurrency = CONCURRENCY,
): Promise<ScenarioResult> {
  const conflictsBefore = await lockConflicts();
  const lag = watchOutboxLag();
  const startedAt = performance.now();
  const outcomes = await inParallel(submissions, submit, concurrency);
  const seconds = (performance.now() - startedAt) / 1000;
  const outboxDrainSeconds = await waitOutboxDrained();
  return {
    name,
    requests: submissions.length,
    seconds,
    samples: outcomes,
    replays: outcomes.filter((outcome) => outcome.replay).length,
    lockConflicts: (await lockConflicts()) - conflictsBefore,
    maxOutboxLag: await lag.stop(),
    outboxDrainSeconds,
  };
}

async function queueScenario(wallets: Wallet[]): Promise<ScenarioResult> {
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl: queueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
  );
  const messages = Array.from({ length: REQUESTS_PER_SCENARIO }, (_, index) => {
    const submission = bet(wallets[index % wallets.length]);
    submission.wallet.debits += 1;
    const messageId = uuid();
    return {
      Id: String(index % 10),
      MessageGroupId: submission.wallet.walletId,
      MessageDeduplicationId: messageId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...submission.body, idempotencyKey: submission.key },
      }),
    };
  });
  const processed = async (): Promise<number> =>
    (await Promise.all(WORKER_METRICS_URLS.map(scrape))).reduce(
      (sum, metrics) =>
        sum +
        sampleValue(
          metrics,
          'wager_message_processing_seconds_count{outcome="processed"}',
        ),
      0,
    );
  const processedBefore = await processed();
  const conflictsBefore = await lockConflicts();
  const lag = watchOutboxLag();
  const startedAt = performance.now();
  for (let index = 0; index < messages.length; index += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.slice(index, index + 10),
      }),
    );
  }
  await until(
    async () => (await processed()) - processedBefore >= messages.length,
    QUEUE_DRAIN_TIMEOUT_SECONDS,
    'o consumo da fila',
  );
  const seconds = (performance.now() - startedAt) / 1000;
  const outboxDrainSeconds = await waitOutboxDrained();
  return {
    name: 'fila: wallets distribuídas',
    requests: messages.length,
    seconds,
    samples: [],
    replays: 0,
    lockConflicts: (await lockConflicts()) - conflictsBefore,
    maxOutboxLag: await lag.stop(),
    outboxDrainSeconds,
  };
}

function percentile(sorted: number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

function queueLatencyPercentiles(metrics: string[]): string {
  const buckets = new Map<number, number>();
  for (const text of metrics) {
    for (const match of text.matchAll(
      /^wager_message_processing_seconds_bucket\{le="([^"]+)",outcome="processed"\} (\d+)$/gm,
    )) {
      const le = match[1] === '+Inf' ? Infinity : Number(match[1]);
      buckets.set(le, (buckets.get(le) ?? 0) + Number(match[2]));
    }
  }
  const ordered = [...buckets.entries()].sort(([a], [b]) => a - b);
  const total = ordered.at(-1)?.[1] ?? 0;
  const bound = (p: number): string => {
    const le = ordered.find(([, count]) => count >= (p / 100) * total)?.[0];
    return le === undefined || le === Infinity ? '> 10 s' : `≤ ${le * 1000} ms`;
  };
  return `p50 ${bound(50)}, p95 ${bound(95)}, p99 ${bound(99)}`;
}

function row(result: ScenarioResult): string {
  const latencies = result.samples
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);
  const statuses = new Map<number, number[]>();
  for (const sample of result.samples) {
    statuses.set(sample.status, [
      ...(statuses.get(sample.status) ?? []),
      sample.ms,
    ]);
  }
  const ok = result.samples.filter((sample) => sample.status === 201).length;
  const errors = result.samples.length - ok;
  const cells = [
    result.name,
    String(result.requests),
    (result.requests / result.seconds).toFixed(0),
    latencies.length ? percentile(latencies, 50).toFixed(1) : '—',
    latencies.length ? percentile(latencies, 95).toFixed(1) : '—',
    latencies.length ? percentile(latencies, 99).toFixed(1) : '—',
    result.samples.length
      ? `${((errors / result.samples.length) * 100).toFixed(2)}%`
      : '—',
    [...statuses.entries()]
      .map(
        ([status, times]) =>
          `${status}: ${times.length} (mediana ${percentile(
            times.sort((a, b) => a - b),
            50,
          ).toFixed(0)} ms)`,
      )
      .join(', ') || '—',
    String(result.replays),
    String(result.lockConflicts),
    result.maxOutboxLag.toFixed(1),
    result.outboxDrainSeconds.toFixed(1),
  ];
  return `| ${cells.join(' | ')} |`;
}

async function verify(
  wallets: Wallet[],
): Promise<{ summary: string; correct: boolean }> {
  let consistent = 0;
  let balanced = 0;
  await inParallel(wallets, async (wallet) => {
    const report = (await (
      await fetch(`${apiUrl()}/wallets/${wallet.walletId}/reconciliation`, {
        method: 'POST',
      })
    ).json()) as { consistent: boolean; storedBalance: { amount: string } };
    if (report.consistent) {
      consistent += 1;
    }
    const expected = formatCents(
      wallet.initialCents - BigInt(wallet.debits) * BET_CENTS,
    );
    if (report.storedBalance.amount === expected) {
      balanced += 1;
    }
  });
  return {
    summary: `reconciliação consistente em ${consistent}/${wallets.length} wallets; saldo igual ao esperado pelas respostas em ${balanced}/${wallets.length}`,
    correct: consistent === wallets.length && balanced === wallets.length,
  };
}

async function main(): Promise<void> {
  try {
    await startStack();
    const warmup = await openWallet('1000.00');
    await inParallel(
      Array.from({ length: WARMUP_REQUESTS }, () => bet(warmup)),
      submit,
    );

    const hot = await openWallet('100000.00');
    const overloaded = await openWallet('100000.00');
    const distributed = await Promise.all(
      Array.from({ length: DISTRIBUTED_WALLETS }, () => openWallet('1000.00')),
    );
    const duplicated = await Promise.all(
      Array.from({ length: DISTRIBUTED_WALLETS }, () => openWallet('1000.00')),
    );
    const queued = await Promise.all(
      Array.from({ length: DISTRIBUTED_WALLETS }, () => openWallet('1000.00')),
    );

    const unique = Array.from(
      { length: Math.round(REQUESTS_PER_SCENARIO * (1 - DUPLICATE_SHARE)) },
      (_, index) => bet(duplicated[index % duplicated.length]),
    );
    const withDuplicates = [
      ...unique,
      ...Array.from(
        { length: REQUESTS_PER_SCENARIO - unique.length },
        (_, index) => unique[(index * 7) % unique.length],
      ),
    ].sort(() => Math.random() - 0.5);

    const results = [
      await httpScenario(
        'HTTP: hot wallet',
        Array.from({ length: REQUESTS_PER_SCENARIO }, () => bet(hot)),
      ),
      await httpScenario(
        `HTTP: hot wallet com ${OVERLOAD_CONCURRENCY} concorrentes`,
        Array.from({ length: REQUESTS_PER_SCENARIO }, () => bet(overloaded)),
        OVERLOAD_CONCURRENCY,
      ),
      await httpScenario(
        'HTTP: wallets distribuídas',
        Array.from({ length: REQUESTS_PER_SCENARIO }, (_, index) =>
          bet(distributed[index % distributed.length]),
        ),
      ),
      await httpScenario('HTTP: 20% de reenvios duplicados', withDuplicates),
      await queueScenario(queued),
    ];

    const workerMetrics = await Promise.all(WORKER_METRICS_URLS.map(scrape));
    const verification = await verify([
      hot,
      overloaded,
      ...distributed,
      ...duplicated,
      ...queued,
    ]);

    console.log(`\n## Resultado\n`);
    console.log(
      `Ambiente: ${cpus()[0]?.model} (${cpus().length} threads), ${(totalmem() / 2 ** 30).toFixed(1)} GB, ${osType()} ${release()}, Bun ${Bun.version}. Concorrência ${CONCURRENCY}, ${REQUESTS_PER_SCENARIO} operações por cenário, ${WARMUP_REQUESTS} de aquecimento.\n`,
    );
    console.log(
      '| Cenário | Operações | Vazão (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Erro | Status | Replays | Conflitos de lock | Lag máx. da outbox (s) | Outbox zerada após (s) |',
    );
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const result of results) {
      console.log(row(result));
    }
    console.log(
      `\nLatência de processamento da fila (histograma dos workers): ${queueLatencyPercentiles(workerMetrics)}.`,
    );
    console.log(`\n${verification.summary}.`);
    if (!verification.correct) {
      throw new Error('saldo ou ledger divergente depois da carga');
    }
  } finally {
    await stopStack();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
