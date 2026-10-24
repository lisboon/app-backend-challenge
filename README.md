# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. O enunciado está em
[`CHALLENGE.md`](CHALLENGE.md) e as decisões em [`ARCHITECTURE.md`](ARCHITECTURE.md).

> Em construção. Este README lista só o que já existe. Os endpoints de negócio
> entram nos próximos incrementos.

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) com Compose v2
- [Bun](https://bun.sh) 1.4.x, para rodar testes e a API fora do container

## Subir tudo

```bash
docker compose up -d --wait
curl http://127.0.0.1:3000/health/ready
```

O `--wait` só retorna quando PostgreSQL, SQS e a API estão saudáveis. As filas
`wager-transactions.fifo` e `wager-transactions-dlq.fifo` são criadas pelo
LocalStack na subida, sem nenhum passo manual.

| Serviço | Endereço local |
|---|---|
| API | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:5432` (usuário, senha e banco `wager`) |
| SQS (LocalStack) | `http://127.0.0.1:4566` |

As portas mudam com `API_PORT`, `POSTGRES_PORT` e `SQS_PORT`.

## Health checks

| Endpoint | Responde |
|---|---|
| `GET /health/live` | `200` enquanto o processo está de pé |
| `GET /health/ready` | `200` com PostgreSQL e SQS alcançáveis; `503` dizendo qual caiu |

## Rodar a API fora do container

```bash
docker compose up -d --wait postgres sqs
cp .env.example .env
bun install
bun run dev
```

## Testes

```bash
bun run test               # unidade
bun run test:e2e           # camada HTTP, sem infraestrutura
bun run infra:test:up      # PostgreSQL e LocalStack de teste (portas 5433 e 4567)
bun run test:integration   # integração contra a infraestrutura real
bun run infra:test:down
```

A infraestrutura de teste usa banco em `tmpfs` e não toca nos dados do ambiente
local. Os endereços dela estão em `.env.test`, que o `bun test` carrega sozinho.

## Qualidade

```bash
bun run lint    # oxlint, incluindo as regras de boundary entre camadas
bun run build   # checagem de tipos
```

O CI (`.github/workflows/ci.yml`) roda unidade, e2e, lint e build, e num segundo
job sobe a infraestrutura real, roda a integração e valida a stack inteira com
`docker compose up --wait --build`.
