# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. O enunciado está em
[`CHALLENGE.md`](CHALLENGE.md) e as decisões em [`ARCHITECTURE.md`](ARCHITECTURE.md).

Wallets com ledger imutável, apostas e reversões por HTTP e pela fila SQS
(com inbox), referências fora de ordem, outbox para os eventos, métricas
Prometheus, logs JSON e teste de carga. A autenticação é um ponto de extensão
documentado, sem Identity Provider (seção 13 da arquitetura).

## Pré-requisitos

- [Docker](https://docs.docker.com/get-docker/) com Compose v2
- [Bun](https://bun.sh) 1.4.x, para rodar testes e a API fora do container

## Subir tudo

```bash
docker compose up -d --wait --build
curl http://127.0.0.1:3000/health/ready
```

O `--wait` só retorna quando PostgreSQL, SQS, API e worker estão saudáveis.
Antes dos processos subirem, `migrate` aplica as migrations e termina. O
LocalStack cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wallet-events.fifo`. O worker consome `wager-transactions.fifo` pelo mesmo
caso de uso da HTTP, publica os eventos confirmados da outbox na fila de
eventos e reprocessa referências pendentes, em ciclos independentes. Nenhum
passo é manual.

| Serviço | Endereço local |
|---|---|
| API | `http://127.0.0.1:3000` |
| Métricas do worker | `http://127.0.0.1:3001/metrics` |
| PostgreSQL | `127.0.0.1:5432` (usuário, senha e banco `wager`) |
| SQS (LocalStack) | `http://127.0.0.1:4566` |

As portas mudam com `API_PORT`, `WORKER_METRICS_PORT`, `POSTGRES_PORT` e `SQS_PORT`.
Para parar, `docker compose down`; para apagar também os dados,
`docker compose down -v`.

## Primeira aposta

Abra uma wallet e guarde o `id` da resposta:

```bash
curl -s -X POST http://127.0.0.1:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```json
{ "id": "<walletId>", "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "balance": { "amount": "1000.00", "currency": "BRL" }, "version": 1 }
```

Aposte 25,00 com esse `id`:

```bash
curl -s -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","walletId":"<walletId>","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "<transactionId>", "status": "PROCESSED", "failureCode": null, "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

Repetir o mesmo comando devolve o mesmo resultado com `idempotentReplay: true`,
sem novo débito. Mudar o valor e manter a chave responde `409`. Para conferir:

```bash
curl -s http://127.0.0.1:3000/wallets/<walletId>
curl -s "http://127.0.0.1:3000/wallets/<walletId>/ledger?limit=10"
curl -s -X POST http://127.0.0.1:3000/wallets/<walletId>/reconciliation
curl -s http://127.0.0.1:3000/wagering/transactions/<transactionId>
curl -s http://127.0.0.1:3000/providers/provider-a/wagering/transactions/bet-1
```

Uma aposta sem saldo é registrada como `REJECTED` e responde `422` com o corpo
da transação, consultável depois pelo `GET`. Os demais erros saem no mesmo
envelope, com um `failureCode` que diz ao provedor se reenviar adianta:

```json
{ "statusCode": 409, "failureCode": "IDEMPOTENCY_PAYLOAD_CONFLICT", "message": "a Idempotency-Key já foi usada com outro payload" }
```

## Endpoints

| Método e rota | Responde |
|---|---|
| `POST /wallets` | `201` com a wallet; `409` se o player já tem wallet nessa moeda; `400` se o payload é inválido |
| `GET /wallets/:walletId` | `200`, `404` ou `400` se o id não é UUID |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50` | `200` com `items` e `nextCursor`; limite de 1 a 100; `400` para query inválida e `404` para wallet inexistente |
| `POST /wallets/:walletId/reconciliation` | Sem corpo; `200` com saldos armazenado/calculado, diferença, consistência e quantidade de entradas; `400` para id inválido e `404` para wallet inexistente |
| `POST /wagering/transactions` | Header `Idempotency-Key` obrigatório; `201` aplicada, `202` aguardando referência, `422` rejeitada com `failureCode`; reenvio consulta o estado atual com `idempotentReplay: true`; `409` para chave ou `externalTransactionId` com outro payload; `404` para wallet inexistente; `503` se o lock não sai em 2 s; `500` com o corpo da transação se a chave já tem um `FAILED` gravado pela fila |
| `GET /wagering/transactions/:transactionId` | `200` com a transação e o saldo observado, `404` ou `400` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200` ou `404` |
| `GET /metrics` | Texto Prometheus: transações por status, replays, conflitos de lock, latência por rota e reconciliação; as métricas do consumo, da outbox e das pendências vêm do worker |
| `GET /health/live` | `200` enquanto o processo está de pé |
| `GET /health/ready` | `200` com PostgreSQL e ambas as filas SQS alcançáveis; `503` dizendo qual dependência caiu |

O extrato retorna lançamentos do mais recente ao mais antigo. Reenvie o
`nextCursor` na próxima consulta; `null` indica o fim. Wallet zero sem
movimentações retorna `items: []`. A reconciliação compara saldo e ledger no
mesmo snapshot, registra divergências e incrementa o contador, sem alterar o
saldo. A diferença é o saldo armazenado menos o calculado.

Com o PostgreSQL indisponível, os endpoints de wallet respondem `503` com
`Retry-After`. Todo erro sai no envelope `{ statusCode, failureCode, message }`.

`X-Correlation-Id` pode ser enviado como UUID. A API devolve o valor normalizado
ou gera um UUIDv7 quando o header falta ou é inválido. O valor acompanha os
eventos financeiros. Replays mantêm a outbox original, sem novos eventos.

Toda rota passa por um `AuthGuard` global; só `/health/live` e `/health/ready`
são públicas. Hoje o autenticador aceita toda requisição: é o ponto de
extensão para um Identity Provider, descrito na
[seção 13 da arquitetura](ARCHITECTURE.md#13-autenticação).

## Apostas, reversões e referência fora de ordem

O submit aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Valores monetários
são strings com duas casas, dentro de `money: { amount, currency }`.
`referenceExternalTransactionId` identifica a transação original no mesmo
provider e aceita 1 a 128 caracteres: obrigatório em REFUND/ROLLBACK, opcional
em WIN e proibido em BET/LOSS. `providerId: "internal"` é reservado. Violações
dessas regras respondem 400, sem gravar transação.

REFUND referencia BET. ROLLBACK referencia BET, WIN ou REFUND e inverte seu
movimento. Reversões exigem valor igual; a referência deve estar processada e
ter o mesmo player, wallet, moeda e rodada. WIN com referência só aceita BET,
sem exigir o mesmo valor. Cada referência aceita uma reversão de cada tipo;
BET já reembolsado não pode receber ROLLBACK enquanto o REFUND não for desfeito.

Exemplo na wallet da primeira aposta, que tem 975,00 depois do `bet-1`. Aplique
um novo BET de 25, reembolse e depois desfaça o próprio reembolso com ROLLBACK
(975 → 950 → 975 → 950). Cada transação tem seu próprio `externalTransactionId`
e sua própria `Idempotency-Key`: repetir `bet-1` com outra chave responde 409
`EXTERNAL_TRANSACTION_CONFLICT`.

```bash
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

Se REFUND chegar antes de BET, a resposta será `202`:

```json
{
  "transactionId": "<id>",
  "status": "PENDING_REFERENCE",
  "failureCode": null,
  "balance": null,
  "idempotentReplay": false
}
```

O worker resolve depois da chegada da referência. Reenviar o mesmo corpo e a
mesma chave retorna `idempotentReplay: true` com o estado atual: 202 enquanto
pendente; 201 quando aplicado; 422 se rejeitado. Depois da resolução, o saldo
retornado é o do desfecho persistido, mesmo que a wallet tenha novas operações.
Os GET por id e por provedor/id externo mostram `referenceExternalTransactionId`
e `referenceTransactionId`; o interno só é preenchido após aplicação.

Referência ausente por uma hora vira REJECTED com `REFERENCE_NOT_FOUND` e
evento de rejeição. Referência ainda pendente não gera essa rejeição; falha
transitória agenda retry, e erro interno encerra a pendência como `FAILED`.
Eventos da resolução preservam o correlationId do primeiro submit; retries não
criam eventos. Regras, precedência, transições e proteções SQL estão na
[seção 10 da arquitetura](ARCHITECTURE.md#10-reversões-e-referências-pendentes).

## Enviar pela fila

A mensagem segue o §10 do enunciado. O grupo FIFO é a wallet, e a fila não
deduplica por conteúdo, então o envio informa o id de deduplicação:

```bash
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text); awslocal sqs send-message --queue-url "$queue_url" --message-group-id "<walletId>" --message-deduplication-id msg-1 --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-26T12:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-q1\",\"idempotencyKey\":\"provider-a:bet-q1\",\"playerId\":\"<playerId>\",\"walletId\":\"<walletId>\",\"roundId\":\"round-1\",\"gameId\":\"game-1\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"'
```

O worker grava a mensagem na inbox na mesma transação do efeito e confirma a
entrega só depois do commit. A mesma mensagem entregue de novo não repete o
efeito. Rejeição de negócio é confirmada como desfecho; falha transitória volta
para a fila com backoff; erro permanente vai para `wager-transactions-dlq.fifo`
com o atributo `failureCode`; depois de 10 recebimentos (~18 min de retries), o redrive do SQS também
move para a DLQ. Os detalhes estão na
[seção 11 da arquitetura](ARCHITECTURE.md#11-consumo-sqs-inbox-e-failed).

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

Em outro terminal, com o mesmo `.env`, inicie o worker de consumo, publicação e referências:

```bash
bun run start:worker
curl http://127.0.0.1:3001/metrics
```

| Variável | Padrão / uso |
|---|---|
| `WAGER_QUEUE_NAME` e `WAGER_DLQ_NAME` | Obrigatórias; filas de entrada e DLQ, com nome FIFO |
| `CONSUMER_CONCURRENCY` | `10`; de 1 a 100 leitores da fila por worker, cada um com uma mensagem por vez |
| `CONSUMER_RETRY_BASE_SECONDS` | `2`; de 1 a 300, base do backoff da mensagem com falha transitória |
| `DATABASE_POOL_MAX` | `15`; de 2 a 200 conexões por processo; no worker, precisa deixar 3 além de `CONSUMER_CONCURRENCY`, e a soma entre processos não pode passar do `max_connections` do PostgreSQL |
| `EVENTS_QUEUE_NAME` | Obrigatória; `.env.example` usa `wallet-events.fifo`. Deve ser um nome FIFO; configura também o hook do LocalStack |
| `OUTBOX_POLL_INTERVAL_MS` | `500`; inteiro de 1 a 2147483647, intervalo entre ciclos do publicador |
| `PENDING_REFERENCE_TTL_SECONDS` | `3600`; prazo desde createdAt para rejeitar uma referência ainda inexistente; mesmo valor na API e no worker |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000`; intervalo entre ciclos de resolução no worker |
| `WORKER_METRICS_PORT` | `3001`; porta das métricas, independente da API |

O catálogo de métricas e logs está na
[seção 12 da arquitetura](ARCHITECTURE.md#12-observabilidade). A outbox publica prefixos de eventos por wallet, em ordem de
sequence, com até dez wallets em paralelo. Uma falha interrompe apenas aquela
wallet, sem tentar seus eventos seguintes. Eventos
com falha recebem backoff exponencial de 1 s até 5 min e continuam pendentes,
sem limite de tentativas. SIGTERM para os schedulers e os leitores da fila,
conclui os lotes e a mensagem em andamento e só então sai.

O ciclo de referências processa até 100 candidatos por lote. Retries usam backoff
de 1 s até 5 min, antecipado quando a referência chega na mesma wallet. A
expiração só rejeita referências inexistentes; referências existentes continuam
pendentes além do TTL, e erro interno vira `FAILED`. A gauge
`pending_reference_transactions` observa o total no banco; evite somá-la entre
workers. As variáveis de intervalo e TTL aceitam inteiros de 1 a 2147483647.

## Eventos, DLQ, métricas e logs

Eventos publicados pela outbox:

```bash
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name "$EVENTS_QUEUE_NAME" --query QueueUrl --output text); awslocal sqs receive-message --queue-url "$queue_url" --max-number-of-messages 10 --wait-time-seconds 2 --message-system-attribute-names All'
```

O corpo contém o envelope versionado, com eventId e correlationId; o grupo é a
wallet. A entrega é at-least-once. Consumidores devem deduplicar por eventId,
inclusive depois da janela de cinco minutos de deduplicação do SQS FIFO.

Mensagens na DLQ, com o motivo no atributo `failureCode` (ausente quando foi o
redrive do SQS, depois de 10 recebimentos):

```bash
docker compose exec sqs sh -c 'queue_url=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text); awslocal sqs receive-message --queue-url "$queue_url" --max-number-of-messages 10 --wait-time-seconds 2 --message-attribute-names All'
```

Métricas e logs:

```bash
curl -s http://127.0.0.1:3000/metrics | grep -E '^(wager_transactions_total|idempotent_replays_total|lock_conflicts_total)'
curl -s http://127.0.0.1:3001/metrics | grep -E '^(wager_message|inbox_duplicates|wager_dlq_messages|outbox_lag_seconds)'
docker compose logs -f api worker
```

Contadores com rótulo, como `lock_conflicts_total{reason}`, só aparecem depois
do primeiro incremento.

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

```bash
bun run test:load          # teste de carga, com 3 APIs e 2 workers
```

O teste de carga sobe e derruba sozinho uma stack isolada (projeto
`wager-load`, imagem `wagering-processor:load`, portas 3100–3102, 3201–3202 e
4700), roda os cenários e confere a reconciliação de toda wallet usada. Leva de
três a quatro minutos. Metodologia,
números e interpretação estão em [`docs/load-test.md`](docs/load-test.md).

## Qualidade

```bash
bun run lint       # oxlint, incluindo as regras de boundary entre camadas
bun run typecheck  # tipos de src/ e tests/
bun run build      # build de produção
```

O CI (`.github/workflows/ci.yml`) roda unidade, e2e, lint, typecheck e build. Num
segundo job, sobe a infraestrutura real, roda a integração e valida a stack
inteira com `docker compose up --wait --build`.
