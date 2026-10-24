# Decisões de arquitetura

Registro das escolhas, do porquê e do que foi descartado. Cada seção nasce no
incremento que tomou a decisão.

## 1. Camadas por módulo

Cada contexto de negócio fica em `src/modules/<contexto>/`:

| Pasta | Papel |
|---|---|
| `domain/` | entidades e objetos de valor. TypeScript puro |
| `usecase/` | um caso de uso por operação |
| `gateway/` | as portas: interfaces de repositório e de serviço externo |
| `repository/` | o adaptador que implementa a porta contra o banco |
| `event/` | os eventos de integração que o contexto publica |

O que é compartilhado entre contextos fica em `src/modules/@shared/`. A borda
(HTTP, fila, workers, banco) fica em `src/infra/`. A pasta só é criada quando
houver arquivo para ela.

**As fronteiras são impostas pelo lint, não por convenção.** O `.oxlintrc.json`
faz `bun run lint` falhar se:

- `domain/` importar NestJS, MikroORM, AWS SDK, class-validator, `infra/`,
  `gateway/`, `repository/` ou `usecase/`;
- `usecase/` importar framework, ORM, `infra/` ou `repository/`.

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

## 3. Taxonomia de falha e status HTTP

Todo `failureCode` pertence a uma natureza. A natureza diz ao provedor o que
fazer sem interpretar mensagem. O mapeamento é um `Record` exaustivo: código sem
natureza, ou natureza sem status, não compila.

A taxonomia cresce com o uso: um código ou uma natureza só existe quando algum
código de produção o lança.

| Natureza | HTTP | Significado para o provedor | Estado |
|---|---|---|---|
| `CONTRACT` | 400 | payload malformado: corrigir antes de reenviar | ativo |
| `NOT_FOUND` | 404 | recurso consultado não existe | ativo |
| `BUSINESS` | 422 | payload válido, regra violada: desfecho terminal e auditável | ativo |
| `INTERNAL` | 500 | defeito do serviço | ativo |
| `CONFLICT` | 409 | chave já usada com outro conteúdo: reenviar igual não muda nada | entra com idempotência e wallet |
| `TRANSIENT` | 503 + `Retry-After` | infraestrutura indisponível: reenviar é seguro | entra com o adaptador de banco |

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
