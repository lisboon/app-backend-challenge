import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import { testInfra, WAGER_QUEUE_NAME } from '../support/http-app';

const ROOT = resolve(import.meta.dir, '../..');
const MAIN = 'src/infra/http/main.ts';
const BOOT_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

function freePort(): number {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
}

function spawnApp(env: Record<string, string>) {
  return Bun.spawn(['bun', '--no-env-file', MAIN], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function waitReady(port: number): Promise<void> {
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

const exitWithin = (exited: Promise<number>): Promise<number | 'timeout'> =>
  Promise.race([
    exited,
    Bun.sleep(EXIT_TIMEOUT_MS).then(() => 'timeout' as const),
  ]);

describe('processo da API', () => {
  it.skipIf(process.platform === 'win32')(
    'com SIGTERM roda os hooks de encerramento antes de sair',
    async () => {
      const infra = testInfra();
      const port = freePort();
      const child = spawnApp({
        PORT: String(port),
        DATABASE_URL: infra.databaseUrl,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        SQS_ENDPOINT: infra.sqsEndpoint,
        WAGER_QUEUE_NAME,
      });
      try {
        await waitReady(port);
        child.kill('SIGTERM');

        expect(await exitWithin(child.exited)).not.toBe('timeout');
        expect(await new Response(child.stdout).text()).toContain(
          'encerramento concluído (SIGTERM)',
        );
      } finally {
        child.kill('SIGKILL');
      }
    },
    BOOT_TIMEOUT_MS + EXIT_TIMEOUT_MS,
  );

  it('recusa subir com configuração inválida e não expõe valores', async () => {
    const child = spawnApp({
      DATABASE_URL: 'mysql://root:senha-secreta@db/wager',
      AWS_REGION: 'us-east-1',
    });
    const exitCode = await exitWithin(child.exited);
    const stderr = await new Response(child.stderr).text();

    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBe('timeout');
    expect(stderr).toContain('WAGER_QUEUE_NAME ausente');
    expect(stderr).toContain('DATABASE_URL deve usar o esquema');
    expect(stderr).not.toContain('senha-secreta');
  });
});
