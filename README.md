# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. O enunciado está em
[`CHALLENGE.md`](CHALLENGE.md) e as decisões em [`ARCHITECTURE.md`](ARCHITECTURE.md).

> Em construção. Este README lista só o que já existe. As transações de aposta
> e o consumidor SQS entram nos próximos incrementos.

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) com Compose v2
- [Bun](https://bun.sh) 1.4.x, para rodar testes e a API fora do container

## Subir tudo

```bash
docker compose up -d --wait
curl http://127.0.0.1:3000/health/ready
```

O `--wait` só retorna quando PostgreSQL, SQS e a API estão saudáveis. Antes da
API subir, o serviço `migrate` aplica as migrations e termina. As filas
`wager-transactions.fifo` e `wager-transactions-dlq.fifo` são criadas pelo
LocalStack na subida. Nenhum passo é manual.

| Serviço | Endereço local |
|---|---|
| API | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:5432` (usuário, senha e banco `wager`) |
| SQS (LocalStack) | `http://127.0.0.1:4566` |

As portas mudam com `API_PORT`, `POSTGRES_PORT` e `SQS_PORT`.

## Endpoints

| Método e rota | Responde |
|---|---|
| `POST /wallets` | `201` com a wallet; `409` se o player já tem wallet nessa moeda; `400` se o payload é inválido |
| `GET /wallets/:walletId` | `200`, `404` ou `400` se o id não é UUID |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50` | `200` com `items` e `nextCursor`; limite de 1 a 100; `400` para query inválida e `404` para wallet inexistente |
| `POST /wallets/:walletId/reconciliation` | Sem corpo; `200` com saldos armazenado/calculado, diferença, consistência e quantidade de entradas; `400` para id inválido e `404` para wallet inexistente |
| `POST /wagering/transactions` | Header `Idempotency-Key` obrigatório; `201` aplicada, `422` rejeitada com `failureCode`; reenvio repete o resultado com `idempotentReplay: true`; `409` para chave ou `externalTransactionId` com outro payload; `404` para wallet inexistente; `503` se o lock não sai em 2 s |
| `GET /wagering/transactions/:transactionId` | `200` com a transação e o saldo observado, `404` ou `400` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` ou `404` |
| `GET /metrics` | Texto Prometheus com `wallet_reconciliation_divergences_total` |
| `GET /health/live` | `200` enquanto o processo está de pé |
| `GET /health/ready` | `200` com PostgreSQL e SQS alcançáveis; `503` dizendo qual caiu |

O extrato retorna lançamentos do mais recente ao mais antigo. Reenvie o
`nextCursor` na próxima consulta; `null` indica o fim. Wallet zero sem
movimentações retorna `items: []`. A reconciliação compara saldo e ledger no
mesmo snapshot, registra divergências e incrementa o contador, sem alterar o
saldo. A diferença é o saldo armazenado menos o calculado.

Com o PostgreSQL indisponível, os endpoints de wallet respondem `503` com
`Retry-After`. Todo erro sai no envelope `{ statusCode, failureCode, message }`.

```bash
curl -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

## Rodar a API fora do container

```bash
docker compose up -d --wait postgres sqs
cp .env.example .env
bun install
bun run migrate:up
bun run dev
```

`migrate:down` reverte a última migration e `migrate:status` lista as aplicadas
e as pendentes.

## Testes

```bash
bun run test               # unidade
bun run test:e2e           # camada HTTP, sem infraestrutura
bun run infra:test:up      # PostgreSQL e LocalStack de teste (portas 5433 e 4567)
bun run test:integration   # integração contra a infraestrutura real
bun run infra:test:down
```

A infraestrutura de teste usa banco em `tmpfs` e não toca nos dados do ambiente
local. Cada suíte de integração reverte todas as migrations e as aplica de novo
antes de rodar. Os endereços estão em `.env.test`, que o `bun test` carrega
sozinho.

## Qualidade

```bash
bun run lint       # oxlint, incluindo as regras de boundary entre camadas
bun run typecheck  # tipos de src/ e tests/
bun run build      # build de produção
```

O CI (`.github/workflows/ci.yml`) roda unidade, e2e, lint, typecheck e build. Num
segundo job, sobe a infraestrutura real, roda a integração e valida a stack
inteira com `docker compose up --wait --build`.
