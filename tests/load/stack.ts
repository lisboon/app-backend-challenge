const PROJECT = ['-p', 'wager-load'];
const FILES = ['-f', 'docker-compose.yml', '-f', 'docker-compose.load.yml'];

export const API_URLS = [3100, 3101, 3102].map(
  (port) => `http://127.0.0.1:${port}`,
);
export const WORKER_METRICS_URLS = [3201, 3202].map(
  (port) => `http://127.0.0.1:${port}/metrics`,
);
export const SQS_ENDPOINT = 'http://127.0.0.1:4700';

async function compose(args: string[]): Promise<void> {
  const child = Bun.spawn(
    ['docker', 'compose', ...PROJECT, ...FILES, ...args],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await child.exited) !== 0) {
    throw new Error(`docker compose ${args[0]} falhou`);
  }
}

export function startStack(): Promise<void> {
  return compose([
    'up',
    '-d',
    '--wait',
    '--build',
    '--scale',
    'api=3',
    '--scale',
    'worker=2',
  ]);
}

export function stopStack(): Promise<void> {
  return compose(['down', '-v']);
}

export async function scrape(url: string): Promise<string> {
  return (await fetch(url)).text();
}

export function sampleValue(metrics: string, series: string): number {
  return metrics
    .split('\n')
    .filter(
      (line) => line.startsWith(series + ' ') || line.startsWith(series + '{'),
    )
    .reduce(
      (sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)),
      0,
    );
}
