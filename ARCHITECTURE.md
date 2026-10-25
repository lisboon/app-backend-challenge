# Decisões de arquitetura

Registro das escolhas, do porquê e do que foi descartado. Cada seção nasce no
incremento que tomou a decisão.

## 1. Camadas por módulo

Cada contexto de negócio fica em `src/modules/<contexto>/`:

| Pasta | Papel |
|---|---|
| `domain/` | entidades e objetos de valor. TypeScript puro |
| `usecase/` | um caso de uso por operação, em `usecase/<ação>/<ação>.usecase.ts` com o DTO ao lado |
| `gateway/` | as portas: interfaces de repositório e de serviço externo |
| `repository/` | o adaptador que implementa a porta contra o banco, com o model e o mapper |
| `factory/` | monta os casos de uso com as dependências concretas |
| `event/` | os eventos de integração que o contexto publica |

O que é compartilhado entre contextos fica em `src/modules/@shared/`. A borda
(HTTP, fila, workers, banco) fica em `src/infra/`. A pasta só é criada quando
houver arquivo para ela.

**As fronteiras são impostas pelo lint, não por convenção.** O `.oxlintrc.json`
faz `bun run lint` falhar se:

- `domain/` importar NestJS, MikroORM, AWS SDK, class-validator, `infra/`,
  `gateway/`, `repository/`, `usecase/` ou `factory/`;
- `usecase/` importar framework, ORM, `infra/`, `repository/` ou `factory/`;
- `domain/`, `usecase/` ou `gateway/` de um contexto importar outro contexto.

**Contextos conversam por portas de quem consome.** A abertura de wallet precisa
registrar a transação interna `OPENING`, que pertence ao contexto de apostas. Em
vez de o caso de uso da wallet conhecer o domínio de apostas, a wallet declara
`OpeningTransactionGateway` com o que precisa, o contexto de apostas fornece o
adaptador (`OpeningTransactionRepository`) e a `WalletFactory` liga os dois.

**Por que existe `factory/`.** O caso de uso não pode importar NestJS, então não
tem `@Injectable()`, e o container do Nest não consegue construí-lo sozinho. A
factory faz essa montagem em TypeScript puro, e o módulo Nest a chama com
`useFactory`. Ela não duplica o DI: é o que permite o caso de uso ficar livre de
framework. Os testes de integração montam o caso de uso do mesmo jeito, sem
subir o Nest, e trocam um gateway por um que falha para provar atomicidade.

**Nomes.** Arquivos, casos de uso e gateways seguem o padrão `create`/`findById`
dos projetos anteriores. Dentro do agregado ficam os verbos do domínio pedidos
no enunciado: `Wallet.open`, `WalletLedgerEntry.create` e `rehydrate`. O
`LedgerGateway` permite criar e consultar lançamentos; a ausência de `update`
e `delete` expressa no contrato que o ledger não muda.

## 2. Money

- **`decimal.js` com construtor clonado e precisão 40.** A precisão padrão (20
  dígitos significativos) vale também para `plus`:
  `999999999999999999.99 + 999999999999999999.99` devolvia
  `2000000000000000000.00`, uma perda silenciosa de 1,98.
- **Validação por regex de formato, nunca `Number()`.** `Number("1e5")`
  devolveria 100000 em silêncio.
- **Contrato de entrada estrito:** não negativo, exatamente 2 casas, sem zero à
  esquerda (`^(0|[1-9]\d{0,17})\.\d{2}$`). O enunciado pede escala fixa de 2.
  Aceitar `"25"` ou `"25.5"` daria duas grafias para a mesma quantia e, com isso,
  dois `payloadHash` para o mesmo pedido. Valores do banco (`NUMERIC(20,2)`) já
  chegam nesse formato.
- **Negativo só nasce dentro do domínio**, por `negate()` ou `subtract()`.
  Aceitá-lo em `from` deixaria a regra "sem negativo em contrato de entrada"
  dependendo de cada DTO lembrar dela. O ledger usa direção + valor positivo, e
  o saldo é não negativo por CHECK, então nenhum caminho de persistência precisa
  reidratar negativo.
- **Faixa de 18 dígitos inteiros**, a mesma de `NUMERIC(20,2)`. Toda operação
  aritmética valida o resultado: um valor que o domínio aceita é um valor que o
  banco grava.
- **Mensagem de erro sem o valor recebido.** Ele fica numa propriedade separada,
  porque mensagem de exceção vai para log e a seção 12 proíbe payload
  financeiro em log.
- **No banco, `NUMERIC(20,2)`, e nenhum valor passa por `number`.** `NUMERIC` é
  decimal exato, não ponto flutuante. A restrição do enunciado é sobre o
  `number` do JavaScript, que é IEEE 754. O driver entrega `NUMERIC` como
  string, o model mapeia com `p.decimal('string')` e o `Money.from` recebe a
  string. O caminho fica coberto em duas camadas: mapear como `number` quebra o
  `typecheck`, e o teste com `999999999999999999.99` (que como `number` viraria
  `1000000000000000000`) confere a API e o banco. Outro teste exige que toda
  coluna de valor seja `numeric(20,2)` e que nenhuma seja `real`, `double` ou
  `money`.

## 3. Taxonomia de falha e status HTTP

Todo `failureCode` pertence a uma natureza. A natureza diz ao provedor o que
fazer sem interpretar mensagem. O mapeamento é um `Record` exaustivo: código sem
natureza, ou natureza sem status, não compila.

A taxonomia cresce com o uso: um código ou uma natureza só existe quando algum
código de produção o lança.

| Natureza | HTTP | Significado para o provedor |
|---|---|---|
| `CONTRACT` | 400 | payload malformado: corrigir antes de reenviar |
| `CONFLICT` | 409 | o recurso já existe ou a chave já foi usada: reenviar igual não muda nada |
| `NOT_FOUND` | 404 | recurso consultado não existe |
| `BUSINESS` | 422 | payload válido, regra violada: desfecho terminal e auditável |
| `TRANSIENT` | 503 + `Retry-After` | infraestrutura indisponível: reenviar é seguro |
| `INTERNAL` | 500 | defeito do serviço |

Um único filtro (`HttpErrorFilter`, registrado como `APP_FILTER`) trata toda
exceção, inclusive as do framework e as inesperadas. Assim, toda resposta de
erro tem o mesmo envelope `{ statusCode, failureCode, message }`:

- erro de domínio: status pela natureza, conforme a tabela;
- exceção 4xx do framework (rota inexistente, corpo grande demais): mantém o
  status específico dela, com `RESOURCE_NOT_FOUND` para 404 e `REQUEST_INVALID`
  para os demais;
- qualquer outra: 500 genérico. O log leva só o nome e os frames da pilha, sem
  a mensagem, que em erro de driver costuma trazer valores da linha.

**Interpretações adotadas:**

- **Rejeição de negócio no submit é 422, não 201.** Uma versão anterior
  respondia 201 com `status: "REJECTED"`, com o argumento de que a transação foi
  registrada. Mas a seção 9 lista a rejeição entre as situações que o código
  HTTP precisa distinguir. Com 201 para aplicada e para rejeitada, só o corpo
  distinguiria. O submit vai responder 422 com o corpo da transação
  (`transactionId`, `status`, `failureCode`), que continua consultável por
  `GET`. Aceite pendente (`PENDING_REFERENCE`) responde 202.
- **`REFERENCE_NOT_FOUND` é `BUSINESS`.** Pela seção 7.1, a referência ausente
  primeiro fica `PENDING_REFERENCE` e só vira rejeição terminal depois do TTL.
- **`CURRENCY_MISMATCH` e `BALANCE_LIMIT_EXCEEDED` são `BUSINESS`.** Os dois só
  surgem de payload bem-formado aplicado a uma wallet (moeda diferente, crédito
  que estouraria a faixa). Entrada fora da faixa já é recusada pelo formato
  (`MONEY_INVALID_FORMAT`).
- **Tentar mudar transação terminal não tem `failureCode`.** O enunciado diz que
  isso é erro de programação, não caminho de negócio. Por isso vira 500
  (`INTERNAL_ERROR`), não 409.

## 4. Infraestrutura local

Todas as imagens são fixadas por digest de índice multi-arquitetura (amd64 e
arm64), para o `docker compose up` ser reprodutível também em Mac com Apple
Silicon.

### SQS: LocalStack 4.12

O enunciado aceita LocalStack ou MiniStack. Os dois foram comparados com o
mesmo SDK e os 17 comportamentos de SQS que a solução usa. Esses comportamentos
estão em `tests/integration/sqs-contract.integration.spec.ts`.

| | LocalStack 4.12 | MiniStack 1.5.22 |
|---|---|---|
| Contrato SQS | 17/17 | 16/17 |
| Download comprimido | 475 MB | 74 MB |
| RAM parado | ~90 MB | ~38 MB |

- **Escolhido pela fidelidade.** No MiniStack, reenviar com o mesmo
  `MessageDeduplicationId` e corpo diferente faz o SDK lançar
  `InvalidChecksumError`: o MD5 devolvido não confere com o corpo enviado.
  Contornar isso exigiria desligar a validação de integridade do SDK.
- **Versão 4.12, não `latest`.** Desde março de 2026 a imagem `latest` exige
  `LOCALSTACK_AUTH_TOKEN` e sai com código 55 sem ele. A 4.12, de dezembro de
  2025, sobe sem token (testado). Com token, o avaliador precisaria criar conta e
  a ativação dependeria de rede.
- **Imagem oficial, sem versão enxuta.** Uma derivada sem Java, Node e serviços
  que não usamos caiu para 791 MB e passou os 17 casos. Mas construída no
  compose ela obriga a baixar a original primeiro, e publicada num registry
  vira um artefato a mais em que o avaliador precisa confiar.
- **`SERVICES=sqs`, `DISABLE_EVENTS=1` e `SKIP_SSL_CERT_DOWNLOAD=1`** baixaram o
  boot de 2,8 s para 2,0 s.
- **Filas criadas por hook de inicialização**
  (`docker/localstack/ready.d/10-create-queues.sh`). O healthcheck consulta a
  fila em vez do estado do hook: com o script sem permissão de execução, o
  LocalStack informa a inicialização como concluída mesmo com o hook falhando.

### PostgreSQL 18

O volume fica em `/var/lib/postgresql`, não em `/var/lib/postgresql/data`. A
partir do 18 a imagem oficial guarda os dados em
`/var/lib/postgresql/18/docker` e recusa subir quando há algo montado no caminho
antigo, com volume ou com `tmpfs`.

### Imagem da API

`oven/bun:1.4.2-alpine`, 185 MB. A Alpine foi a menor entre as bases do Bun
(slim 278 MB, distroless 168 MB), com o mesmo boot (~0,9 s) e a mesma RAM
(~34 MB). Nenhuma dependência tem addon nativo, então o musl não é problema.

- **Sem etapa de build.** O Bun executa TypeScript direto, então a imagem leva
  só `node_modules` de produção, `src/` e `tsconfig.json`.
- **Código do root, processo como `bun`** (UID 1000). O processo não consegue
  alterar o próprio código.
- **`.dockerignore` em lista branca.** Só entram `package.json`, `bun.lock`,
  `tsconfig.json` e `src/`, nunca `.env`.

### MikroORM 7 num projeto CommonJS

O MikroORM 7 só publica ESM. O projeto continua CommonJS: com `module: nodenext`,
o TypeScript 6 aceita importar ESM a partir de CommonJS. Migrar para ESM
obrigaria extensão `.js` em todo import relativo. O custo é não poder usar
`await` no topo de um módulo.

### Restrições do Bun

- **O processo precisa rodar com a raiz do projeto como diretório de trabalho.**
  O Bun lê o `tsconfig.json` a partir do diretório de execução, e sem ele os
  decorators do NestJS quebram no boot. O `--tsconfig-override` não resolve:
  o próprio Bun 1.4.2 acusa um bug interno. Os scripts e o `WORKDIR /app` da
  imagem garantem isso.
- **Tipo usado em parâmetro decorado vai com `import type`.** Com
  `emitDecoratorMetadata`, ele vira referência de valor, e uma interface não
  existe em runtime.
- **`SIGTERM` sai com 143 fora de container e 0 dentro.** O NestJS roda os
  hooks de encerramento e reenvia o sinal ao próprio processo. Como PID 1 no
  container, o kernel ignora esse reenvio. O teste de processo confere que os
  hooks rodaram, não o código de saída.

### Readiness

`/health/ready` faz `select 1` no PostgreSQL e `GetQueueUrl` nas filas de
comandos e de eventos, em paralelo e com 2 s de timeout por dependência.

- **A app sobe com dependência fora** e reconecta sozinha quando ela volta. O
  enunciado assume PostgreSQL e SQS temporariamente indisponíveis, e um
  processo que morre no boot nunca chegaria a responder 503.
- **`GetQueueUrl` em vez de só testar a porta**, para acusar também fila não
  provisionada.
- **O log diz qual dependência caiu e por quê, sem URL de conexão.** Erro com
  código sai só com o código (`ECONNREFUSED`, ou o SQLSTATE do servidor, cuja
  mensagem pode trazer valores). Erro sem código, como timeout de conexão, sai
  com a mensagem: ele não veio do servidor, e o probe só executa comandos
  constantes.
- **O pool não esgota com o banco congelado.** O `connectionTimeoutMillis`
  também limita a espera por uma conexão livre. Com o PostgreSQL pausado, 20
  chamadas simultâneas responderam 503 em ~1 s, e a API voltou a 200 assim que o
  banco voltou.

## 5. Wallet, ledger e invariantes no schema

A abertura de wallet grava a wallet, a transação interna `OPENING` e o crédito
de abertura numa única transação SQL. Saldo inicial zero não gera `OPENING` nem
lançamento. A wallet nasce com `version` 1.

Cada garantia do enunciado tem uma constraint ou um trigger correspondente, e
cada um tem um teste que o viola por SQL cru
(`tests/integration/schema.integration.spec.ts`):

| Garantia | No schema |
|---|---|
| uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)`, e nos saldos do lançamento |
| lançamento fecha a conta | `CHECK` de `balance_after = balance_before ± amount` conforme a direção |
| no máximo um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| sem atualização perdida | `UNIQUE (wallet_id, wallet_version)` |
| ledger imutável | trigger que recusa `UPDATE`, `DELETE` e `TRUNCATE` (`P0001`) |
| lançamento só existe para transação aplicada que move saldo | trigger diferido: a transação está `PROCESSED` e não é `LOSS`, e valor, moeda e player batem com ela e com a wallet |
| direção coerente com o tipo | `wallet_ledger_entries_match_transaction`: `BET` debita; `OPENING`, `WIN` e `REFUND` creditam; `ROLLBACK` inverte a direção do lançamento referenciado |
| transação aplicada que move saldo tem lançamento | trigger diferido em `wager_transactions` |
| desfecho registra o saldo observado | `CHECK`: `PROCESSED` e `REJECTED` têm `result_balance` e `result_currency`, pendente não tem |
| `BET` e `WIN` têm valor positivo | `CHECK (kind = 'LOSS' or amount > 0)` |
| lançamento é da wallet da transação | FK composta `(transaction_id, wallet_id)` |
| idempotência por provedor | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| `OPENING` é interno | `CHECK ((provider_id = 'internal') = (kind = 'OPENING'))` |
| toda alteração de saldo tem lançamento, e vice-versa | trigger diferido no `COMMIT`: o saldo e a versão da wallet batem com o último lançamento, e cada lançamento continua o saldo do anterior |
| eventId único na outbox | `outbox_messages_pk` |
| ordem persistida por wallet | `sequence bigint generated always as identity`, com `outbox_sequence_uk`; atribuída com o lock da wallet retido |
| evento persistido imutável | trigger `outbox_event_immutable`: recusa alteração de id, agregado, tipo, payload, ocorrência e sequence, e recusa `DELETE` |
| outbox não pode ser truncada | trigger de statement `outbox_event_no_truncate` |
| tentativas não negativas e publicação posterior à ocorrência | `outbox_attempts_ck` e `outbox_published_at_ck` |

| identidade da wallet imutável | trigger `wallets_protect` recusa mudar id, player e moeda (23514) |
| transação auditável e terminal imutável | `wager_transactions_protect` recusa DELETE, UPDATE terminal, alteração de identidade e transição inválida; `wager_transactions_no_truncate` recusa TRUNCATE (23514) |
| referência interna somente no desfecho aplicado com referência externa | `wager_tx_reference_state_ck` |
| referência pertence à mesma wallet | FK composta `wager_tx_reference_wallet_fk` |
| referência processada, compatível em tipo, identidade e valor da reversão | trigger diferido `wager_transactions_reference_valid` (23514) |
| reversão única por tipo e referência | índice parcial `wager_tx_single_reversal_uk` (23505) |
| BET revertido uma única vez em termos líquidos, e WIN só sobre BET que ainda vale | trigger diferido `wager_transactions_single_net_reversal` (23514) |
| tentativas não negativas, próxima tentativa somente em pendência, referência proibida em BET/LOSS/OPENING, nenhuma referência a si mesma | `wager_tx_reference_attempts_ck`, `wager_tx_pending_reference_ck`, `wager_tx_reference_not_allowed_ck` e `wager_tx_reference_not_self_ck` |

**Interpretações adotadas:**

- **O lançamento guarda a versão da wallet** (`wallet_version`), que não está
  no esqueleto do enunciado. É ela que transforma uma atualização perdida em
  violação de unicidade e dá ao extrato uma ordem estável.
- **`initialBalance` é obrigatório** em `POST /wallets`. Para abrir sem saldo,
  envia-se `"0.00"`.
- **UUIDs chegam em qualquer caixa e são normalizados para minúsculas**, para a
  resposta da abertura e a da consulta mostrarem o mesmo valor.
- **Qualquer código ISO-4217 é aceito.** O modelo é multimoeda e cada moeda tem
  a sua wallet.

A abertura com saldo positivo grava `WagerTransactionProcessed` de `OPENING` e
`WalletBalanceChanged` na outbox, na mesma transação da abertura. Saldo zero
não gera eventos. A publicação depois do commit está descrita na seção 9.

## 6. Transações e erros de banco

Todo acesso ao banco passa pelo `TransactionManager`, inclusive as leituras.
O adaptador abre um `EntityManager` isolado (`em.fork()`) por chamada e executa
o trabalho de `execute` em `READ COMMITTED`, com `lock_timeout` de 2 s. Os gateways recebem o contexto da transação como
parâmetro obrigatório, então nenhuma escrita acontece fora de uma transação.

**A tradução de erro do driver é feita pelo código, não pela classe.** Pela API
de entidades, o MikroORM embrulha o erro (`UniqueConstraintViolationException`);
pela execução SQL direta, devolve o `DatabaseError` cru do driver. O código
aparece nos dois casos:

| Código | Vira |
|---|---|
| `23505` na constraint `wallets_player_currency_uk` | `WALLET_ALREADY_EXISTS` (409) |
| `23505` em `wager_tx_idempotency_uk` | nova tentativa do submit, que encontra a transação gravada (seção 8) |
| `23505` em `wager_tx_external_uk` | `EXTERNAL_TRANSACTION_CONFLICT` (409) |
| `23505` em `wager_tx_single_reversal_uk` | `REFERENCE_ALREADY_REVERSED`; o submit refaz uma tentativa e registra a rejeição de negócio (422) |
| `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, classe `08`, `57P01`–`57P03`, timeout de conexão do pool, `55P03` (lock não obtido), `40001`, `40P01` | `INFRASTRUCTURE_UNAVAILABLE` (503 + `Retry-After`) |
| qualquer outro | 500, porque é defeito, não condição de negócio |

**Concorrência na abertura.** Vinte `POST /wallets` simultâneos para o mesmo
player e moeda resultam em um 201 e dezenove 409. O índice único serializa as
inserções, e a tradução do `23505` faz o conflito chegar como resposta de
contrato, não como 500.

## 7. Extrato e reconciliação

O extrato usa paginação por chave sobre `wallet_version`, em ordem decrescente,
apoiada pelo índice único `(wallet_id, wallet_version)`. A próxima página busca
versões estritamente menores que a última devolvida. Consultar `limit + 1`
permite informar o fim sem contar todos os lançamentos. Novos lançamentos não
deslocam as páginas já percorridas, como aconteceria com `OFFSET`.

O cursor pertence ao transporte HTTP: base64url de
`{"v":1,"walletVersion":<n>}`. O caso de uso recebe apenas a versão. A leitura
valida o alfabeto base64url, o JSON, os campos permitidos, a versão do formato
e a faixa de inteiros positivos do PostgreSQL para a versão da wallet. Falhas
entram na validação do zod e saem pelo `parseRequest`, como as demais entradas.
O cursor é opaco, mas não tem assinatura: uma versão válida reencodificada é
uma posição de consulta válida. O contrato não prevê autenticação do cursor.
A query é estrita, com limite padrão 50 e faixa de 1 a 100.

A reconciliação usa `TransactionManager.snapshot`: uma transação
`REPEATABLE READ` com `readOnly: true`. Saldo e soma enxergam o mesmo snapshot,
mesmo que um débito concorrente seja confirmado entre as leituras. A opção
somente leitura também impede uma correção acidental. O adaptador compartilha
com `execute` a tradução de erros de conexão.

O caso de uso carrega a wallet e passa sua moeda ao gateway do extrato, sem
nova consulta à wallet no repositório. Créditos e débitos são somados
separadamente no SQL em `NUMERIC`, convertidos para `numeric(20,2)::text` e
reconstruídos como `Money`. O saldo calculado nasce de `créditos.subtract(débitos)`,
sem conversão monetária para `number` nem manipulação de sinal em strings.
O relatório calcula armazenado menos calculado, incluindo diferenças negativas.
Wallet zero sem entradas soma zero.

Divergências são relatadas, nunca corrigidas: a reconciliação é uma auditoria,
e mudar saldo ocultaria a inconsistência sem produzir uma movimentação
financeira válida. Após concluir o snapshot, somente divergências acionam o
monitor, com aviso estruturado contendo walletId, diferença e quantidade de
entradas, sem saldo completo nem payload recebido.

O módulo global de observabilidade fornece um `Registry` próprio do
`prom-client` 15.1.3. Cada aplicação possui seu contador
`wallet_reconciliation_divergences_total`; não há registro global padrão nem
métricas automáticas. `GET /metrics` usa o content type desse registro.
O contador é local ao processo e reinicia com ele; o Prometheus agrega as
instâncias. As métricas da outbox estão na seção 9. As demais métricas da seção
12 acompanham os próximos incrementos de consumo e inbox. As referências pendentes estão na seção 10.

## 8. Submissão de transações de aposta

`POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, com o header
`Idempotency-Key` obrigatório. Tudo acontece numa transação SQL:

1. trava a wallet com `SELECT ... FOR UPDATE`; wallet inexistente é `404`, sem
   gravar nada;
2. procura a chave em `(provider_id, idempotency_key)`. Se existe, o payload é
   comparado pelo `payloadHash`: igual devolve o resultado gravado com
   `idempotentReplay: true`; diferente é `IDEMPOTENCY_PAYLOAD_CONFLICT` (409);
3. resolve a referência por provedor e id externo e avalia as regras contra a
   wallet travada, na precedência descrita na seção 10;
4. aplica o movimento pelo agregado `Wallet` (`debit` ou `credit`), grava a
   wallet condicionada à versão lida e o lançamento; `LOSS` não move saldo;
5. grava a transação com o desfecho, o saldo observado e o evento na outbox.
   Quando há movimento, o adaptador da wallet também grava seu evento.

O lock da wallet é o ponto de serialização: reenvios da mesma chave para a
mesma wallet esperam o primeiro terminar e encontram a transação gravada.
A transação é inserida depois do lançamento, então a FK do ledger para a
transação é verificada no `COMMIT` (`DEFERRABLE INITIALLY DEFERRED`).

A mesma chave enviada para wallets diferentes não compartilha lock. O índice
único resolve a disputa: o perdedor recebe `23505`, o caso de uso refaz a
tentativa uma vez com um candidato novo, encontra a transação do vencedor e
responde conforme o payload. O mesmo `externalTransactionId` com outra chave
é `EXTERNAL_TRANSACTION_CONFLICT` (409).

`lock_timeout` de 2 s limita a espera pelo lock. Estourado, o PostgreSQL
devolve `55P03`, que vira `503` com `Retry-After`, sem efeito: o cliente
reenvia com a mesma chave.

| Desfecho | HTTP | Corpo |
|---|---|---|
| aplicada | `201` | `{ transactionId, status: "PROCESSED", failureCode: null, balance, idempotentReplay }` |
| rejeitada por regra de negócio | `422` | o mesmo corpo com `status: "REJECTED"` e o `failureCode` |
| referência pendente | `202` | `{ transactionId, status: "PENDING_REFERENCE", failureCode: null, balance: null, idempotentReplay }` |
| reenvio | o do estado atual | o desfecho persistido com `idempotentReplay: true` |

**`payloadHash`.** `v1:` seguido do SHA-256 em hexadecimal do JSON canônico
de `{ providerId, externalTransactionId, walletId, playerId, roundId, gameId,
kind, money: { amount, currency }, referenceExternalTransactionId? }`: chaves ordenadas por código UTF-16 em
todos os níveis, sem espaços, campos ausentes omitidos. O header
`Idempotency-Key`, o id interno e as datas não entram. Como `amount` só aceita
uma grafia por quantia (seção 2), o mesmo pedido gera sempre o mesmo hash.
O prefixo de versão permite trocar o algoritmo sem confundir hashes antigos.
A referência participa somente quando presente; hashes antigos sem referência
são preservados, com valores fixos calculados no main cobertos por testes.

`balance` é o saldo observado no desfecho e fica gravado na transação
(`result_balance`, `result_currency`). O reenvio devolve esse valor, não o
saldo atual, porque responde ao pedido original.

**Interpretações adotadas:**

- **Rejeições de negócio são gravadas.** `INSUFFICIENT_BALANCE`,
  `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `BALANCE_LIMIT_EXCEEDED` e as
  falhas de referência da seção 10 viram transações `REJECTED`,
  consultáveis e idempotentes. Por isso a transação referencia só a wallet; a
  coerência de player e moeda com o ledger é garantida pelos triggers da
  seção 5.
- **Erros de contrato não são gravados.** Payload inválido, `OPENING`, valor
  zero em operações financeiras, provider reservado `internal`, referência
  obrigatória ausente ou proibida e chave ausente respondem `400` antes da transação.
- **`LOSS` aceita valor zero.** Ele só registra o fim da rodada.
- **Idempotência por provedor.** A mesma chave em provedores diferentes são
  transações distintas.
- **Limites de tamanho são de contrato.** `providerId` até 64 caracteres,
  `externalTransactionId`, `roundId` e `gameId` até 128, `Idempotency-Key` até
  255, com espaços nas pontas removidos. As colunas são `text`; o limite
  protege índices e logs, e quem passa dele recebe `400`.

**Limitações:** consumo pela fila de entrada, inbox e recuperação para `FAILED`
em falhas persistentes entram no próximo incremento. Uma referência existente
que não pode ser aplicada continua pendente, mesmo após o TTL; o operador deve
acompanhar retries e resolver a causa.

## 9. Outbox

O envelope é uma classe abstrata `IntegrationEvent<T>`. Cada evento define seu
tipo e versão: `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference` e `WalletBalanceChanged`, todos na versão 1. Os dados contêm `MoneyProps`, com
valores em string; a ocorrência é serializada em ISO-8601. Abertura, `BET`,
`WIN`, `LOSS`, `REFUND` e `ROLLBACK` aplicados geram o evento processado. Rejeição gera somente o
evento rejeitado. Só alterações de saldo geram `WalletBalanceChanged`.

O input dos casos de uso recebe `correlationId`. A borda HTTP preserva um UUID
válido de `X-Correlation-Id`, normalizado para minúsculas; na ausência ou
invalidade, gera UUIDv7. Uma função única guarda o id resolvido em uma propriedade
do request, preservando o header bruto. Interceptor e filtro de erros usam a
mesma função; os controllers recebem `@CorrelationId()`. A resposta devolve o
header também para JSON malformado e rota inexistente, que falham antes do
interceptor. O replay pode ter outro header, mas não grava eventos novos nem
altera a correlação do evento original. `WalletBalanceChanged.causationId`
aponta para o `eventId` de `WagerTransactionProcessed` da mesma transação.
Os outros eventos não têm causationId. IDs vêm do `IdGenerator`, e o `Clock`
fornece o instante do desfecho. No submit, esse instante é lido depois do lock
da wallet, para que a espera pelo lock não antecipe a ocorrência do evento.

O caso de uso de submit grava primeiro o evento da transação. O adaptador de
movimento devolve o saldo e uma operação para registrar seu evento, chamada
após o registro do processado. Assim, `WagerTransactionProcessed` precede
`WalletBalanceChanged` na sequência, sem transferir a montagem do evento de
saldo para o contexto de apostas. A porta de abertura liga os dois contextos
sem fazer o caso de uso da wallet importar o domínio de apostas. Todas essas
gravações recebem o mesmo contexto do `TransactionManager`: falhar antes ou
depois da inserção da outbox desfaz também transação, wallet e ledger. A
migration cria a outbox vazia; não reconstrói eventos de operações anteriores.

`OutboxMessage` mantém tentativas, próxima tentativa e publicação. Seu payload
é o envelope serializado e não muda nos retries. O schema recusa alterações
dos campos do evento e remoção por `DELETE` ou `TRUNCATE`. Só os metadados de publicação
podem mudar. Há índice parcial de vencimento para pendentes e outro por
agregado e sequence para encontrar o antecessor. Uma migration reversível
adiciona a sequência e as proteções à tabela, inclusive para ambientes de
revisão que já aplicaram a migration de criação. As constraints e os
triggers têm testes por SQL cru; os nomes das constraints `NOT NULL` do
PostgreSQL 18 são conferidos no catálogo, pois o diagnóstico `23502` informa
a coluna, mas não envia o nome da constraint.

O enunciado não fixa o destino dos eventos. Escolhemos a fila
`wallet-events.fifo`, reaproveitando a infraestrutura SQS e permitindo várias
instâncias consumidoras idempotentes. `EVENTS_QUEUE_NAME` configura seu nome, validado como
FIFO; o hook do LocalStack cria a fila sem deduplicação por conteúdo. O corpo
é o envelope persistido, `MessageGroupId` é o walletId e
`MessageDeduplicationId` é o eventId.

O publicador roda em processo separado, sem a API HTTP, criado por
`NestFactory.createApplicationContext`. Cada ciclo seleciona até 100 eventos
devidos, em ordem de `sequence`, com `FOR UPDATE SKIP LOCKED`, publica
no SQS, atualiza os metadados e confirma a transação. A sequência é atribuída
no INSERT, com o lock financeiro retido, e preserva a ordem por wallet entre
processos. UUIDv7 e occurredAt não são usados para desempatar ou encontrar
antecessores. Publishers não esperam as linhas já capturadas por
outro e wallets distintas avançam em paralelo, sem lock global.

**A ordem por wallet exige mais que SKIP LOCKED.** A consulta identifica o
primeiro pendente de cada agregado e o primeiro retry futuro. Trava somente
cabeças devidas com SKIP LOCKED; uma cabeça travada por outro publisher exclui
a wallet inteira. Para as wallets capturadas, seleciona o prefixo contíguo de
devidos, até o primeiro retry futuro e o limite global do lote. O recheck da
cabeça considera o estado atual da linha para não aproveitar um snapshot
anterior a uma publicação concorrente.

Dentro da wallet, os envios são seriais. Se um envio falhar, somente esse evento
agenda retry: os seguintes não são tentados e não incrementam attempts.
O paralelismo de dez passa a ser entre wallets. Um erro não impede as outras
wallets do lote. Todos os resultados em andamento são aguardados antes de
propagar um erro de banco e liberar os locks. Uma wallet pode drenar vários
eventos em um ciclo; o teste com cinquenta BETs, duas APIs e dois publishers
publica os 102 eventos, incluindo a abertura, em até três ciclos.

O SQL exclui publicados e o domínio também confere `isDue` antes do envio.
As duas camadas têm testes independentes, pois uma protege consultas e a
outra protege o caso de uso mesmo diante de um gateway que devolva mensagens
publicadas ou ainda não devidas.

Testes diretos do repositório também verificam o corte do prefixo no primeiro
retry futuro e o recheck da cabeça publicada depois do snapshot. No segundo,
uma view temporária preserva os valores da tabela e intercala um lock
consultivo na leitura da sequência. O teste espera esse lock no PostgreSQL,
confirma a publicação em outra transação e libera a consulta original.
A wallet não pode entrar nesse lote; seu próximo pendente fica disponível
na consulta seguinte. As remoções isoladas das duas cláusulas SQL fazem
esses testes falharem, sem depender de `isDue` ou do `break` do caso de uso.

Usamos `SendMessage` individual para associar cada confirmação ou falha à sua
linha. A URL da fila é resolvida uma vez por instância do adaptador, compartilhando
a mesma Promise entre chamadas concorrentes. Falhas na consulta ou erro de fila
inexistente invalidam o cache. Os retries do SDK são desativados: o retry pertence à outbox, que grava
`attempts`, `next_attempt_at` e apenas o código ou a classe em `last_error`.
O backoff é `1s × 2^(attempts-1)`, sem jitter, com teto de cinco minutos.
**Não há limite de tentativas nem descarte para DLQ:** um evento confirmado
nunca é abandonado. O atraso deve ser acompanhado pelo lag e resolvido pela
operação. O intervalo entre ciclos vem de `OUTBOX_POLL_INTERVAL_MS`, padrão
500 ms, inteiro positivo dentro da faixa suportada pelo timer do runtime.

O envio ocorre depois do commit financeiro, mas antes do commit do lote da
outbox. Se o processo morrer, o PostgreSQL aborta o lote e libera os locks.
Outra instância assume os pendentes. Se o SQS recebeu e o commit falhou, haverá
novo envio do mesmo eventId. Essa entrega é **at-least-once**: o FIFO deduplica
por cinco minutos, mas isso não substitui a deduplicação persistente por
eventId no consumidor, que será implementado com a inbox.

O worker usa o Registry próprio já existente. Expõe `outbox_lag_seconds`
(idade do pendente mais antigo, inclusive em retry, zero quando vazio),
`outbox_published_total`, `outbox_publish_failures_total` e
`outbox_publish_retries_total`, com label `event_type`. O último incrementa a
cada `scheduleRetry`, distinguindo retentativas agendadas de falhas de envio.
O contador de publicação acompanha confirmações de envio,
incluindo reenvios após falha de commit; não representa eventos únicos.
Métricas são locais ao processo e reiniciam com ele. A API também registra
essas famílias, mas os valores de publicação devem ser coletados no worker.

Um servidor `Bun.serve` expõe somente `/metrics` em `WORKER_METRICS_PORT`,
padrão 3001, sem subir uma segunda aplicação HTTP Nest. O servidor compartilha
o ciclo de vida do contexto. Logs JSON do worker carregam os identificadores
disponíveis e código ou classe da falha, sem corpo do evento, saldo, valor
recebido ou URL de conexão. `providerId` é null no evento de saldo, cujo
contrato não contém esse campo.

Em SIGTERM, um handler fecha o contexto Nest, espera o lote em andamento e
encerra com zero. O scheduler para antes de destruir o cliente SQS e o pool
do banco. O tratamento explícito evita o reenvio do sinal pelo Nest, que fora
de container produziria 143; SIGINT usa `enableShutdownHooks`. O Compose
reserva dois minutos para encerramento. Uma interrupção forçada mantém a
recuperação pela outbox. Os testes de processo cobrem SIGKILL no lote e
SIGTERM sem iniciar outro; o teste de SIGTERM é pulado no Windows.

**Limitação operacional:** reverta a `Migration20261024000004OutboxOrdering`
somente com a outbox drenada: o `down` derruba a coluna `sequence`, e o `up`
a recria como identity, reatribuindo os valores sem preservar explicitamente
a ordem anterior. Com eventos pendentes, a ordem de publicação pode passar
a depender da ordem física das linhas.

## 10. Reversões e referências pendentes

### Referências, reversão única e precedência

A referência é resolvida por `(providerId, referenceExternalTransactionId)`.
`REFUND` exige `BET`; `ROLLBACK` exige `BET`, `WIN` ou `REFUND`. `WIN` pode
referenciar `BET`, mas também continua funcionando sem referência. Uma operação
não pode referenciar a si mesma (`REFERENCE_SELF`, 400, e
`wager_tx_reference_not_self_ck` no schema): ela ficaria esperando por ela
própria. Player, wallet, moeda e rodada precisam coincidir. A busca já garante
o mesmo provedor e o id externo; o trigger SQL confere de novo os dois.
Referência `REJECTED` é recusada;
referência inexistente ou ainda `PENDING_REFERENCE` deixa a operação pendente.
Somente `PROCESSED` pode ser aplicada. `OPENING` nunca serve como referência.

A referência externa é obrigatória em `REFUND`/`ROLLBACK` e opcional em `WIN`.
Interpretamos que é proibida em `BET` e `LOSS`, pois o enunciado não define
referência para esses tipos. Falhas de contrato não gravam transação:
`REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `REFERENCE_SELF` e
`PROVIDER_RESERVED` são 400.
O identificador `internal` pertence exclusivamente à abertura de wallet.

A primeira falha determina o desfecho, nesta ordem:

1. Player dono e moeda da wallet: `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH`.
2. Tipo da referência: `REFERENCE_KIND_INVALID`.
3. Identidade da referência: `REFERENCE_MISMATCH`.
4. Estado da referência: `REFERENCE_NOT_PROCESSED` ou espera.
5. Reversão já aplicada: `REFERENCE_ALREADY_REVERSED`.
6. Valor diferente do original: `REVERSAL_AMOUNT_MISMATCH`.
7. Saldo e limite: `INSUFFICIENT_BALANCE` para BET,
   `REVERSAL_INSUFFICIENT_BALANCE` para débito de reversão e
   `BALANCE_LIMIT_EXCEEDED` para qualquer crédito acima de NUMERIC(20,2).

Todas as falhas de negócio são 422, persistidas e consultáveis, com evento de
rejeição e o saldo observado. O estouro é avaliado antes da aplicação do
movimento, para não perder o registro de auditoria por exceção aritmética.
`REFERENCE_NOT_FOUND` também é negócio, exclusivamente na expiração descrita
abaixo. WIN com referência não exige valor igual e não tem limite de quantidade,
desde que o BET ainda valha (ver abaixo).

REFUND credita o mesmo valor do BET. ROLLBACK inverte a direção da referência:
BET gera crédito; WIN e REFUND geram débito. A validação de domínio usa o tipo;
a defesa SQL exige a direção inversa do lançamento real da referência.

Uma referência aceita no máximo uma reversão processada de cada tipo. Além
disso, um BET não pode ter simultaneamente ROLLBACK e REFUND ainda não desfeito.
Um REFUND desfeito por ROLLBACK do próprio REFUND deixa de contar na reversão
líquida; isso não permite outro REFUND do mesmo BET. Não se reverte ROLLBACK.

| Sequência com saldo inicial 100 e BET de 25 | Conta e desfecho |
|---|---|
| BET → REFUND → ROLLBACK(BET) | 100 → 75 → 100; último rejeitado, pois levaria a 125 |
| BET → ROLLBACK(BET) → REFUND | 100 → 75 → 100; último rejeitado |
| BET → REFUND → ROLLBACK(REFUND) → ROLLBACK(BET) | 100 → 75 → 100 → 75 → 100; aceita |

**WIN depende de um BET que ainda vale.** O §3 trata a operação com referência
como dependente da referenciada, e a tabela do §7 diz que o REFUND "reverte uma
`BET`". Um WIN que referencia um BET revertido em termos líquidos, pela mesma
regra acima, é rejeitado com `REFERENCE_ALREADY_REVERSED`, inclusive quando
estava pendente e o BET chegou já devolvido. Sem isso, o prêmio de uma aposta
cancelada seria pago sem stake. O schema confere o mesmo no trigger
`wager_transactions_single_net_reversal`.

| Sequência com saldo inicial 100 | Conta e desfecho |
|---|---|
| BET 25 → REFUND → WIN 500 | 100 → 75 → 100; WIN rejeitado, pois levaria a 600 sem aposta valendo |
| BET 25 → REFUND → ROLLBACK(REFUND) → WIN 500 | 100 → 75 → 100 → 75 → 575; aceita, o BET voltou a valer |

A regra é assimétrica de propósito: reverter um BET que já tem WIN continua
permitido, porque o provedor pode cancelar a aposta. Desfazer o prêmio é papel
do `ROLLBACK` do próprio WIN, que segue as regras de reversão.

### Estados, persistência e aplicação compartilhada

A tabela é fechada; qualquer outra transição é erro de programação
`InvalidTransactionStateError`, convertido em 500, sem código de negócio.

| Estado atual | Próximos estados |
|---|---|
| `PENDING` | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED` |
| `PROCESSED` | nenhum |
| `REJECTED` | nenhum |

Retries atualizam somente metadados de uma pendente, sem transição de estado.
O trigger SQL permite essa atualização, mas recusa mudança de identidade,
DELETE de qualquer transação e todo UPDATE terminal, inclusive sem alteração.
A identidade é tudo exceto status, falha, saldo observado, referência interna,
tentativas, próxima tentativa e processed_at. TRUNCATE tem proteção de statement.
A wallet preserva id, player e moeda. `FAILED` permanece fora do domínio deste
incremento; linhas legadas nesse estado também são protegidas como terminais.

`WagerTransaction.rejectionFor` concentra as regras. `WagerTransactionSettlement`
é o colaborador de submit e `ResolvePendingWagerTransactionsUseCase`: resolve
a referência, aplica wallet/ledger e registra o desfecho e a outbox no mesmo
contexto transacional. Submit insere; resolver atualiza. Não há segundo caminho
financeiro no worker. O lock da wallet serializa as reversões concorrentes.
As proteções SQL da seção 5 continuam sendo a última defesa, inclusive para SQL
direto. A migration é reversível e seu round-trip é testado com dados.

A coluna `correlation_id` preserva a requisição original. O backfill de linhas
anteriores usa o próprio id da transação, pois a correlação original não estava
persistida. Por isso, reverter a `Migration20261025000005WagerReversals` e
aplicá-la de novo sobre uma base populada substitui as correlações reais pelo
id da transação, como a ressalva da coluna `sequence` da outbox (issue #10). O
worker reutiliza esse valor nos eventos de resolução. Ambos os
identificadores de referência aparecem no GET; o interno fica preenchido
somente em uma transação processada que tenha referência externa.

O primeiro aceite pendente responde 202, com saldo e failureCode nulos, e grava
`WagerTransactionPendingReference` v1. Replays mostram o estado atual: 202 enquanto
pendente, 201 após aplicação ou 422 após rejeição. O saldo terminal é o observado
na resolução, preservado em replays mesmo após novas operações na wallet.
Reprocessamento sem mudança de status não gera evento; aplicação gera
`WagerTransactionProcessed` e depois `WalletBalanceChanged`, com causationId do
processado. Rejeição ou expiração gera `WagerTransactionRejected`.

### Prazo, concorrência e recuperação

O TTL padrão é uma hora desde createdAt, configurável em
`PENDING_REFERENCE_TTL_SECONDS` (3600). É uma janela operacional escolhida para
permitir retries e atrasos dos provedores sem deixar indefinidamente um saldo
diferente do esperado e sem reprocessamento ilimitado de referências ausentes.
Não representa um SLA medido dos provedores; deve ser ajustado à integração.

`exponentialBackoff`, função pura compartilhada com a outbox, calcula
`1s × 2^(attempts-1)` com teto de cinco minutos. A pendência nasce com contador zero e primeira consulta agendada em um segundo;
cada retry incrementa o contador antes de calcular o backoff. Para referência
ausente, o agendamento é limitado ao
próprio deadline, para o backoff não adiar a expiração. Somente se a referência
continuar inexistente ao vencer o prazo ocorre `REFERENCE_NOT_FOUND` e evento
rejeitado. Referência existente, ainda pendente, continua esperando além do TTL;
referência existente processada continua podendo ser aplicada após esse prazo.

A consulta de candidatos devidos não toma locks. Cada candidato segue:

1. Abre uma transação e trava a wallet, com o lock_timeout existente.
2. Trava a transação pendente com `FOR UPDATE SKIP LOCKED`.
3. Confere novamente status e vencimento. Se outro worker resolveu ou reagendou,
   sai sem efeito; senão usa o mesmo colaborador do submit.
4. Confirma todos os efeitos financeiros e eventos atomicamente.

A ordem é sempre wallet antes da linha da transação. Assim, aceleração de
pendentes durante um submit não cria um ciclo de locks com o resolver. A chegada
de qualquer transação processada antecipa para now as pendentes que a referenciam
por provedor e id externo, somente na mesma wallet e no mesmo commit SQL.
Pendentes de outra wallet não são tocadas; recebem REFERENCE_MISMATCH no seu
ciclo normal. Índices parciais de vencimento e referência sustentam as buscas.

Uma falha inesperada aborta movimento, desfecho e outbox. O resolver agenda retry
numa transação nova, repetindo wallet antes da linha, status e vencimento.
Falha de infraestrutura ou aplicação nunca é convertida em referência ausente.
Se o reagendamento também falhar, registra a falha e deixa a pendente para um
ciclo posterior. Esse caminho não impõe TTL: uma referência existente com defeito
continua pendente até recuperação; FAILED é responsabilidade do próximo passo.

O mesmo processo worker executa dois ciclos com intervalos próprios. O novo
`PendingReferenceWorker` usa `PENDING_REFERENCE_POLL_INTERVAL_MS`, padrão 1000,
e lote de até 100 candidatos. SIGTERM para os schedulers e aguarda os lotes em
andamento antes de destruir o pool; uma interrupção forçada é recuperada pelo
estado persistido. Os testes com dois processos, reinício e SIGTERM rodam em
Linux; no Windows, SIGTERM não oferece a mesma semântica de sinal.

O Registry existente expõe `pending_reference_transactions` (gauge),
`pending_reference_resolved_total` (counter com outcome processed/rejected/expired)
e `pending_reference_retries_total`. Logs levam identificadores e
código ou classe da falha, sem payload financeiro. Contadores são locais ao
processo; a gauge é uma observação do total no banco, e não deve ser somada entre
workers como se cada processo possuísse pendentes diferentes.