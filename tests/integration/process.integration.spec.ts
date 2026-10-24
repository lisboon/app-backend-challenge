import { describe, expect, it } from 'bun:test';

import {
  BOOT_TIMEOUT_MS,
  freePort,
  spawnApp,
  testAppEnv,
  waitReady,
} from '../support/process';

const EXIT_TIMEOUT_MS = 5_000;

const exitWithin = (exited: Promise<number>): Promise<number | 'timeout'> =>
  Promise.race([
    exited,
    Bun.sleep(EXIT_TIMEOUT_MS).then(() => 'timeout' as const),
  ]);

describe('processo da API', () => {
  it.skipIf(process.platform === 'win32')(
    'com SIGTERM roda os hooks de encerramento antes de sair',
    async () => {
      const port = freePort();
      const child = spawnApp(testAppEnv(port));
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
