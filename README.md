# Distributed Wagering Processor

Serviço de wallets e apostas para provedores de jogo, feito para o desafio
técnico da Jungle Gaming ([enunciado](CHALLENGE.md)). Recebe apostas, prêmios e
reversões por HTTP e pela fila SQS, aplica cada efeito financeiro uma vez,
mesmo com reenvios e várias instâncias, mantém um ledger imutável e publica os
eventos por uma outbox. O que fiz para cada exigência do enunciado, e por quê,
está na [arquitetura](ARCHITECTURE.md).

## Executar

**Pré-requisitos:** Docker com Compose v2. Bun 1.4.x para os testes e para
rodar fora do container.

```sh
git clone https://github.com/lisboon/app-backend-challenge.git
cd app-backend-challenge
docker compose up -d --wait --build
curl http://127.0.0.1:3000/health/ready
```

O `--wait` só retorna com PostgreSQL, SQS, API e worker saudáveis. O serviço
`migrate` aplica as migrations antes da API e do worker, e o LocalStack cria as
filas. Nenhum passo é manual.

| Serviço | Endereço |
|---|---|
| API | `http://127.0.0.1:3000` |
| Métricas do worker | `http://127.0.0.1:3001/metrics` |
| PostgreSQL | `127.0.0.1:5432` (usuário, senha e banco `wager`) |
| SQS (LocalStack) | `http://127.0.0.1:4566` |

## Primeira aposta

Abra uma wallet e guarde o `id` da resposta:

```sh
curl -s -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Aposte 25,00, trocando `<walletId>` pelo `id` recebido:

```sh
curl -s -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","walletId":"<walletId>","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "<transactionId>", "status": "PROCESSED", "failureCode": null, "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

Repetir o comando devolve o mesmo resultado com `idempotentReplay: true`, sem
novo débito. Mudar o valor e manter a chave responde 409. Confira:

```sh
curl -s http://127.0.0.1:3000/wallets/<walletId>
curl -s "http://127.0.0.1:3000/wallets/<walletId>/ledger?limit=10"
curl -s -X POST http://127.0.0.1:3000/wallets/<walletId>/reconciliation
```

O saldo é 975,00, o extrato tem o crédito de abertura e o débito, e a
reconciliação responde `consistent: true`.

## API

Dinheiro é sempre `{ "amount": "25.00", "currency": "BRL" }`, com exatamente
duas casas. Todo erro sai no envelope `{ statusCode, failureCode, message }`.
`X-Correlation-Id` (UUID) é preservado ou gerado, e volta no header da resposta.

| Método e rota | Resposta |
|---|---|
| `POST /wallets` | 201 com a wallet; 409 se o player já tem wallet na moeda |
| `GET /wallets/:walletId` | 200 ou 404 |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | 200 com `items` e `nextCursor`, do mais recente ao mais antigo; `limit` de 1 a 100 |
| `POST /wallets/:walletId/reconciliation` | 200 com saldo armazenado, calculado, diferença e consistência; nunca corrige o saldo |
| `POST /wagering/transactions` | header `Idempotency-Key` obrigatório; ver os desfechos abaixo |
| `GET /wagering/transactions/:transactionId` | 200 com a transação e o saldo observado no desfecho |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 ou 404 |
| `GET /health/live`, `GET /health/ready` | liveness; readiness com PostgreSQL e as duas filas |
| `GET /metrics` | Prometheus da API; o do worker fica na porta 3001 |

**Desfechos do submit:**

| Situação | Resposta |
|---|---|
| aplicada | 201, `status: "PROCESSED"` e o saldo |
| rejeição de negócio | 422, `status: "REJECTED"` e o `failureCode`; fica gravada e consultável |
| referência ainda não chegou | 202, `status: "PENDING_REFERENCE"` |
| reenvio da mesma chave e payload | o status do estado atual, com `idempotentReplay: true` |
| mesma chave com outro payload | 409 `IDEMPOTENCY_PAYLOAD_CONFLICT` |
| mesmo id externo com outra chave | 409 `EXTERNAL_TRANSACTION_CONFLICT` |
| falha transitória | 503 `INFRASTRUCTURE_UNAVAILABLE` com `Retry-After`; reenviar com a mesma chave |

**Códigos de falha:**

| HTTP | Códigos |
|---|---|
| 400 | `REQUEST_INVALID`, `MESSAGE_INVALID`, `MONEY_INVALID_FORMAT`, `CURRENCY_INVALID`, `IDEMPOTENCY_KEY_MISSING`, `TRANSACTION_KIND_NOT_SUBMITTABLE`, `TRANSACTION_AMOUNT_INVALID`, `PROVIDER_RESERVED`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `REFERENCE_SELF` |
| 409 | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_PAYLOAD_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT`, `MESSAGE_ID_PAYLOAD_CONFLICT` |
| 404 | `RESOURCE_NOT_FOUND`, `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| 422 | `INSUFFICIENT_BALANCE`, `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`, `MONEY_OUT_OF_RANGE`, `BALANCE_LIMIT_EXCEEDED`, `REFERENCE_NOT_FOUND`, `REFERENCE_KIND_INVALID`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REVERSAL_AMOUNT_MISMATCH`, `REVERSAL_INSUFFICIENT_BALANCE` |
| 503 | `INFRASTRUCTURE_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR`, `PROCESSING_FAILED` |

**Reversões.** `REFUND` referencia um `BET`; `ROLLBACK` referencia um `BET`, um
`WIN` ou um `REFUND` e inverte o movimento; os dois exigem o mesmo valor e a
mesma wallet, player, moeda e rodada. Na wallet acima (975,00), um `BET` de 25,
o `REFUND` dele e o `ROLLBACK` do `REFUND` levam o saldo a 950, 975 e 950:

```sh
curl -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-2' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-2","walletId":"<walletId>","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","roundId":"round-2","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

curl -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:refund-2' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-2","walletId":"<walletId>","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","roundId":"round-2","gameId":"game-1","kind":"REFUND","referenceExternalTransactionId":"bet-2","money":{"amount":"25.00","currency":"BRL"}}'

curl -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:rollback-refund-2' \
  -d '{"providerId":"provider-a","externalTransactionId":"rollback-refund-2","walletId":"<walletId>","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","roundId":"round-2","gameId":"game-1","kind":"ROLLBACK","referenceExternalTransactionId":"refund-2","money":{"amount":"25.00","currency":"BRL"}}'
```

Se a referência ainda não existe, a resposta é 202 e o worker aplica quando ela
chegar; sem ela em uma hora, a transação vira `REJECTED` com
`REFERENCE_NOT_FOUND`.

## Fila e eventos

A mensagem segue o §10 do enunciado, com o grupo FIFO igual à wallet:

```sh
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text); awslocal sqs send-message --queue-url "$queue_url" --message-group-id "<walletId>" --message-deduplication-id msg-1 --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-26T12:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-q1\",\"idempotencyKey\":\"provider-a:bet-q1\",\"playerId\":\"<playerId>\",\"walletId\":\"<walletId>\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"'
```

Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference` e `WalletBalanceChanged`) saem em
`wallet-events.fifo`, em ordem por wallet. A entrega é at-least-once: quem
consome deduplica por `eventId`. Para ver os eventos e a DLQ:

```sh
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name "$EVENTS_QUEUE_NAME" --query QueueUrl --output text); awslocal sqs receive-message --queue-url "$queue_url" --max-number-of-messages 10 --wait-time-seconds 2'
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text); awslocal sqs receive-message --queue-url "$queue_url" --max-number-of-messages 10 --wait-time-seconds 2 --message-attribute-names All'
```

## Testar

```sh
bun install --frozen-lockfile
bun run lint && bun run typecheck && bun run build
bun run test                # unidade
bun run test:e2e            # camada HTTP, sem infraestrutura
bun run infra:test:up       # PostgreSQL e LocalStack de teste (portas 5433 e 4567)
bun run test:integration    # integração contra a infraestrutura real
bun run infra:test:down
```

A infraestrutura de teste usa banco em `tmpfs` e não toca os dados locais. O CI
roda tudo isso e sobe a stack inteira com `docker compose up --wait --build`.

`bun run test:load` sobe uma stack isolada com 3 APIs e 2 workers, roda os
cenários de carga e confere todas as wallets usadas. Resultados e análise:
[teste de carga](docs/load-test.md).

## Rodar fora do container

```sh
docker compose up -d --wait postgres sqs
cp .env.example .env
bun install --frozen-lockfile
bun run migrate:up
bun run dev               # API
bun run start:worker      # worker, em outro terminal
```

O processo precisa rodar com a raiz do projeto como diretório de trabalho: o
Bun lê o `tsconfig.json` de lá. A configuração é validada no boot, e o
[`.env.example`](.env.example) traz todas as variáveis. As que mudam o
comportamento:

| Variável | Padrão | Efeito |
|---|---|---|
| `DATABASE_POOL_MAX` | `15` | conexões por processo; no worker, precisa deixar 3 além de `CONSUMER_CONCURRENCY` |
| `CONSUMER_CONCURRENCY` | `10` | leitores da fila por worker, uma mensagem por vez cada |
| `CONSUMER_RETRY_BASE_SECONDS` | `2` | base do backoff da mensagem com falha transitória |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do publicador quando o lote não veio cheio |
| `PENDING_REFERENCE_TTL_SECONDS` | `3600` | prazo para rejeitar uma referência que não chegou |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | intervalo do ciclo de pendências |

No Compose, `API_PORT`, `WORKER_METRICS_PORT`, `POSTGRES_PORT` e `SQS_PORT`
mudam as portas publicadas.

## Encerrar

```sh
docker compose down       # mantém o volume do PostgreSQL
docker compose down -v    # apaga também os dados
```
