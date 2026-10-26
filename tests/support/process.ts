import { resolve } from 'node:path';

import {
  EVENTS_QUEUE_NAME,
  testInfra,
  WAGER_DLQ_NAME,
  WAGER_QUEUE_NAME,
} from './http-app';

const ROOT = resolve(__dirname, '../..');
const MAIN = 'src/infra/http/main.ts';

export const BOOT_TIMEOUT_MS = 15_000;

export type AppProcess = ReturnType<typeof spawnApp>;

export function freePort(): number {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => undefined },
  });

  const { port } = probe;
  probe.stop(true);
  return port;
}

export function testAppEnv(port: number): Record<string, string> {
  const infra = testInfra();
  return {
    PORT: String(port),
    DATABASE_URL: infra.databaseUrl,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_ENDPOINT: infra.sqsEndpoint,
    WAGER_QUEUE_NAME,
    WAGER_DLQ_NAME,
    EVENTS_QUEUE_NAME,
  };
}

export function spawnApp(env: Record<string, string>) {
  return Bun.spawn(['bun', '--no-env-file', MAIN], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

export async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`).catch(
      () => undefined,
    );
    if (response?.status === 200) {
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`a app não ficou pronta em ${BOOT_TIMEOUT_MS}ms`);
}

export function spawnWorker(env: Record<string, string>) {
  return Bun.spawn(['bun', '--no-env-file', 'src/infra/worker/main.ts'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}
