import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { connect, type Socket } from 'node:net';

import { startApp } from '../support/http-app';

const IDLE_BEYOND_NODE_DEFAULT_MS = 6000;

describe('keep-alive do servidor HTTP', () => {
  let app: INestApplication;
  let url: URL;

  beforeAll(async () => {
    const running = await startApp();
    app = running.app;
    url = new URL(running.baseUrl);
  });

  afterAll(async () => {
    await app.close();
  });

  const request = (socket: Socket): Promise<string> =>
    new Promise((resolve, reject) => {
      let received = '';
      const onData = (chunk: Buffer): void => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) {
          socket.off('data', onData);
          socket.off('close', onClose);
          resolve(received.slice(0, received.indexOf('\r\n')));
        }
      };
      const onClose = (): void => reject(new Error('servidor fechou o socket'));
      socket.on('data', onData);
      socket.once('close', onClose);
      socket.write(
        `GET /health/live HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`,
      );
    });

  it('mantém o socket ocioso além dos 5 s padrão do Node para o cliente reaproveitar', async () => {
    const socket = connect(
      Number(url.port),
      url.hostname.replace(/[[\]]/g, ''),
    );
    await new Promise((resolve) => socket.once('connect', resolve));
    try {
      expect(await request(socket)).toBe('HTTP/1.1 200 OK');
      await Bun.sleep(IDLE_BEYOND_NODE_DEFAULT_MS);
      expect(socket.destroyed).toBe(false);
      expect(await request(socket)).toBe('HTTP/1.1 200 OK');
    } finally {
      socket.destroy();
    }
  }, 15_000);
});
