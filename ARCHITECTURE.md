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
  `GET`. Aceite pendente (`PENDING_REFERENCE`) vai ser 202.
- **`REFERENCE_NOT_FOUND` é `BUSINESS`.** Pela seção 7.1, a referência ausente
  primeiro fica `PENDING_REFERENCE` e só vira rejeição terminal depois do TTL.
- **`CURRENCY_MISMATCH` e `MONEY_OUT_OF_RANGE` são `BUSINESS`.** Os dois só
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

`/health/ready` faz `select 1` no PostgreSQL e `GetQueueUrl` na fila de
comandos, em paralelo e com 2 s de timeout cada.

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
| moeda e player da transação são os da wallet | FK composta `(wallet_id, player_id, currency)` |
| lançamento é da wallet da transação | FK composta `(transaction_id, wallet_id)` |
| idempotência por provedor | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| `OPENING` é interno | `CHECK ((provider_id = 'internal') = (kind = 'OPENING'))` |
| toda alteração de saldo tem lançamento, e vice-versa | trigger diferido no `COMMIT`: o saldo e a versão da wallet batem com o último lançamento, e cada lançamento continua o saldo do anterior |

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

**Limitação:** a abertura ainda não publica `WalletBalanceChanged`. O evento
entra junto com a outbox, na mesma transação da abertura.

## 6. Transações e erros de banco

Todo acesso ao banco passa pelo `TransactionManager`, inclusive as leituras.
O adaptador abre um `EntityManager` isolado (`em.fork()`) por chamada e executa
o trabalho de `execute` em `READ COMMITTED`. Os gateways recebem o contexto da transação como
parâmetro obrigatório, então nenhuma escrita acontece fora de uma transação.

**A tradução de erro do driver é feita pelo código, não pela classe.** Pela API
de entidades, o MikroORM embrulha o erro (`UniqueConstraintViolationException`);
pela execução SQL direta, devolve o `DatabaseError` cru do driver. O código
aparece nos dois casos:

| Código | Vira |
|---|---|
| `23505` na constraint `wallets_player_currency_uk` | `WALLET_ALREADY_EXISTS` (409) |
| `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, classe `08`, `57P01`–`57P03`, timeout de conexão do pool | `INFRASTRUCTURE_UNAVAILABLE` (503 + `Retry-After`) |
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
instâncias. As demais métricas da seção 12 entram com os futuros incrementos
de processamento de apostas, retries, inbox e outbox.
