# Guia para agentes

Regras permanentes deste repositório. Valem para qualquer tarefa, venha ela de
uma issue ou de uma conversa. A tarefa específica está na issue; o que não
estiver lá segue este guia.

## Fontes de verdade, nesta ordem

1. `CHALLENGE.md`: o enunciado. Nunca editar.
2. `ARCHITECTURE.md`: decisões já tomadas e o porquê. Toda decisão nova entra aqui.
3. O código e os testes existentes. Antes de criar algo, procure o padrão que já
   existe e siga-o.

Se a issue contradiz o enunciado ou uma decisão do `ARCHITECTURE.md`, não
escolha sozinho: pare e registre a dúvida na descrição do PR.

## Stack e comandos

Bun 1.4.2, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 18, SQS via
LocalStack 4.12. A verificação completa, que precisa sair toda verde:

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run build
bun run test
bun run test:e2e
bun run infra:test:up && bun run test:integration && bun run infra:test:down
docker compose up -d --wait --build && curl -fsS http://127.0.0.1:3000/health/ready
```

Se o ambiente não tiver Docker, rode o que for possível, envie a branch e use o
resultado do CI. Diga no PR o que não rodou localmente.

## Mapa do repositório

Todo arquivo novo cabe numa linha desta tabela. Antes de criar um, abra o
arquivo de referência da linha e copie a forma: imports, ordem dos membros,
nome da classe e do teste. Um arquivo que não cabe em nenhuma linha exige
atualizar esta tabela **no mesmo PR**, com o motivo na descrição. Sem isso, o
PR não é aprovado.

| O quê | Onde e nome | Exporta | Referência |
|---|---|---|---|
| Agregado ou entidade | `src/modules/<ctx>/domain/<nome>.entity.ts` | classe `<Nome>`, construtor privado, `create`/`open`/`rehydrate` | `wallet/domain/wallet.entity.ts` |
| Objeto de domínio sem identidade | `src/modules/<ctx>/domain/<nome>.ts` | classe ou função pura | `wallet/domain/wallet-reconciliation.ts` |
| Erros de um contexto | `src/modules/<ctx>/domain/errors/<ctx>.errors.ts` | um `DomainError` por condição | `wagering/domain/errors/wagering.errors.ts` |
| Erro compartilhado | `src/modules/@shared/domain/errors/<nome>.error.ts`, ou `<tema>.errors.ts` se forem vários | idem | `@shared/domain/errors/wallet-not-found.error.ts` |
| Evento de integração | `src/modules/<ctx>/event/<nome-do-evento>.event.ts` | classe com o nome do `eventType`, `static from(...)` | `wallet/event/wallet-balance-changed.event.ts` |
| Dados comuns a vários eventos | `src/modules/<ctx>/event/<nome>-event.data.ts` | interface + função que monta | `wagering/event/wager-transaction-event.data.ts` |
| Porta (gateway) | `src/modules/<ctx>/gateway/<nome>.gateway.ts` | `interface <Nome>Gateway`, transação como último parâmetro | `wallet/gateway/wallet.gateway.ts` |
| Porta de observação | `src/modules/<ctx>/gateway/<nome>-monitor.gateway.ts` | `interface <Nome>Monitor` | `wallet/gateway/reconciliation-monitor.gateway.ts` |
| Adaptador de banco | `src/modules/<ctx>/repository/<nome>.repository.ts`, `<nome>.model.ts`, `<nome>.model.mapper.ts`, **o mesmo `<nome>` da entidade** | `<Nome>Repository`, `<Nome>Model`, `<Nome>ModelMapper` | `wallet/repository/wallet.*.ts` |
| Adaptador de outra tecnologia (SQS, métrica) | `src/infra/<tecnologia>/<nome>.ts` | classe que implementa a porta | `infra/observability/reconciliation-monitor.ts` |
| Caso de uso | `src/modules/<ctx>/usecase/<ação>/<ação>.usecase.ts` e `.usecase.dto.ts`. A pasta é **só a ação** (`create`, `find-by-id`, `submit`, `reconcile`, `resolve-pending`), com qualificador apenas quando a ação sozinha for ambígua dentro do módulo (`list-ledger`). O módulo já está no caminho; não o repita | a classe **inclui o agregado**, porque é nome global: `<Ação><Agregado>UseCase` (`FindWalletByIdUseCase`), com DTOs e interface no mesmo prefixo | `wallet/usecase/find-by-id/` |
| Saída compartilhada entre casos de uso | `src/modules/<ctx>/usecase/<nome>.output.dto.ts` | interface + função `to<Nome>Output` | `wallet/usecase/wallet.output.dto.ts` |
| Colaborador usado por mais de um caso de uso | `src/modules/<ctx>/usecase/<nome>.ts` | uma classe com um propósito, sem framework; função pura quando não guarda dependência nem estado | `wagering/usecase/wager-transaction-settlement.ts`, `wagering/usecase/wager-transaction-candidate.ts` |
| Contrato de entrada usado por mais de um canal (HTTP e fila) | `src/infra/contract/<nome>.contract.ts` | schemas zod estritos | `infra/contract/wager-transaction.contract.ts` |
| Documento além de README e ARCHITECTURE | `docs/<nome>.md` | — | `docs/load-test.md` |
| Montagem do contexto | `src/modules/<ctx>/factory/<ctx>.factory.ts` | `const <Ctx>Factory = { create(...) }` | `wallet/factory/wallet.factory.ts` |
| Rota HTTP | `src/infra/http/<ctx>/<ctx>.controller.ts`, `.module.ts`, `.request.ts` | controller sem regra, só `parseRequest` e caso de uso | `infra/http/wallet/` |
| Peça transversal da API | `src/infra/http/shared/<nome>.ts`, agrupada em subpasta quando forem várias do mesmo tema | interceptor, filtro, decorator, middleware ou provider de ciclo, registrado no `AppModule`; o que precisa rodar antes do body parser entra em `configureHttpApplication`, chamada pelo `main.ts` e pelos testes | `infra/http/shared/correlation.interceptor.ts`, `infra/http/shared/configure-http-application.ts` |
| Ciclo de worker | `src/infra/worker/<nome>-worker.ts` | `@Injectable` com `OnModuleInit`/`OnModuleDestroy` | `infra/worker/outbox-worker.ts` |
| Decisão pura de um worker | `src/infra/worker/<nome>.ts` | função pura sem framework nem I/O, testada em unidade | `infra/worker/message-disposition.ts` |
| Migration | `src/infra/database/migrations/Migration<AAAAMMDD><NNNNNN><Nome>.ts`, listada em `index.ts` | `up` e `down` | `Migration20261024000002WagerSubmit.ts` |
| Verificação automatizada | `scripts/<nome>.ts`; configuração ESM em `scripts/package.json` | script executável em Bun | `scripts/check-imports.ts` |
| Teste | `tests/unit/<ctx>/<arquivo>.spec.ts`, `tests/integration/<área>.integration.spec.ts`, `tests/e2e/<área>.e2e.spec.ts`; apoio em `tests/support/` | — | `tests/unit/wallet/wallet.entity.spec.ts` |
| Teste de carga | `tests/load/<nome>.ts`, rodado por `bun run test:load` contra a stack de `docker-compose.load.yml` | script Bun, sem dependência nova | `tests/load/run.ts` |

Regras que acompanham o mapa:

- `domain/` não traduz erro técnico (código de driver, de rede ou do SDK). Quem
  traduz é o adaptador, que entrega um erro de domínio ou um `Error` com `code`
  normalizado.
- Uma classe ou interface nova segue o nome da linha do mapa. Não invente
  sufixo (`Service`, `Manager`, `Helper`, `Utils`, `Handler`) que o mapa não
  tem.
- Antes de criar, procure: se já existe arquivo que faz aquilo, estenda-o.
  Não crie uma segunda versão.

## Imports

Verificado por `bun run lint` (oxlint e `scripts/check-imports.ts`):

- primeiro os pacotes externos, depois uma linha em branco, depois os caminhos
  relativos;
- os relativos em ordem lexical da string do caminho. Por isso `../../../x` vem
  antes de `../../x`, que vem antes de `./x`, e `./wallet.model` vem antes de
  `./wallet.model.mapper`;
- import novo entra na posição da ordem, nunca no topo nem no fim do bloco;
- linha em branco depois do último import, exigida pelo oxlint
  (`import/newline-after-import`).

## Nomes

- Caso de uso: `usecase/<ação>/<ação>.usecase.ts` e `<ação>.usecase.dto.ts`, com a
  pasta só com a ação (`submit`, `find-by-id`) e a classe com o agregado:
  `{Ação}{Agregado}UseCase`, `{Ação}{Agregado}UseCaseInputDto`,
  `{Ação}{Agregado}UseCaseOutputDto` e `{Ação}{Agregado}UseCaseInterface`
  (`SubmitWagerTransactionUseCase`). Teste de unidade: `<ação>.usecase.spec.ts`.
- Gateway: `<nome>.gateway.ts`, com métodos `create`, `update`, `findById` e a
  transação como último parâmetro.
- Repositório: `<nome>.repository.ts`, `<nome>.model.ts` (`defineEntity`) e
  `<nome>.model.mapper.ts`.
- Entidade: `<nome>.entity.ts`, com construtor privado e factories estáticas
  (`create`, `open`, `rehydrate`). `rehydrate` não revalida transições.

## Regras de código

- Linha em branco entre membros de classe (construtor, métodos).
- `if` sempre com chaves, mesmo de uma linha.
- Tipo de retorno explícito em toda função e método de `src/`.
- Textos em português com acentuação correta em código, mensagens de erro, nomes
  de teste e documentação. Só as mensagens de commit ficam sem acento.
- Teste de uma classe existente entra no spec que já existe para ela.
- Nome de classe de caso de uso inclui o agregado (`CreateWalletUseCase`,
  `FindWalletByIdUseCase`); a pasta não (`wallet/usecase/create/`).
- **Sem comentários.** Só quando o código não consegue dizer o porquê sozinho.
  Explicação de decisão vai para o `ARCHITECTURE.md`.
- **Sem código morto.** Só existe o que algum código de produção usa. Teste não
  conta como uso. Isso vale para funções, métodos, propriedades, códigos de
  falha, enums e portas: não antecipe o que só uma tarefa futura vai usar.
- **Sem espaguete.** Funções curtas com um propósito; um nível de abstração por
  função; nada de flag booleana que muda o comportamento.
- **Dinheiro nunca passa por `number`.** `Money` (decimal.js) no domínio,
  `NUMERIC(20,2)` no banco, `p.decimal('string')` no model, string no JSON.
- **Erros:** condição de contrato, conflito ou negócio é `DomainError` com
  `failureCode`; violação de invariante é `Error` comum e vira 500. Erro do
  driver é traduzido pelo código (SQLSTATE ou código de rede), nunca pela classe.
- **Logs e mensagens de erro nunca carregam valor recebido, URL de conexão ou
  payload financeiro completo.**
- Tipo usado em parâmetro decorado é importado com `import type`.
- Entrada HTTP validada com zod estrito (`z.strictObject`) por `parseRequest`.
- Dependência nova: versão exata, publicada há pelo menos 14 dias.
- Formatação: `bun run format` antes de commitar.

## Testes

- Unidade para o domínio; e2e para a camada HTTP sem infraestrutura; integração
  contra PostgreSQL e LocalStack reais. Nunca substitua os dois por mock.
- Todo teste que mexe em saldo confere a invariante do enunciado: saldo da wallet
  igual ao saldo reconstruído pelo ledger (`ledgerMatchesBalance`).
- Constraint de banco nova ganha um teste que a viola por SQL cru e confere o
  nome dela.
- Para cada comportamento crítico, faça uma mutação proposital, confirme que
  algum teste falha e desfaça. Liste as mutações no PR.
- Falha de infraestrutura no meio do trabalho é caminho testado, não exceção.
  Todo ponto de entrada novo (rota, ciclo de worker, consumidor) entra em
  `tests/integration/connection-fault.integration.spec.ts`: a queda de conexão
  dentro da transação responde como transitória (503 ou retry, nunca 500,
  `FAILED` ou DLQ), não deixa efeito parcial e não consome recurso para sempre.
  Depois das quedas, a operação volta a funcionar e o processo encerra.

## Rubrica

Antes de abrir o PR, dê nota à própria entrega e corrija até chegar a 96 ou
mais. A tabela vai preenchida na descrição do PR, com evidência para cada nota.

| # | Critério | Pts |
|---|---|---|
| R1 | Correção: nenhum bug latente no que o PR entrega | 25 |
| R2 | Aderência ao `CHALLENGE.md` nas seções que o PR toca | 20 |
| R3 | Testes: cobrem o comportamento, passam em clone limpo, infraestrutura real onde o enunciado exige | 15 |
| R4 | Integridade: commits atômicos, cada commit compila sozinho, mensagens verdadeiras, CI verde | 15 |
| R5 | Arquitetura: fronteiras respeitadas, portas, simplicidade | 10 |
| R6 | Código limpo: sem comentários, sem código morto, sem espaguete | 10 |
| R7 | Documentação das decisões no `ARCHITECTURE.md` e no `README.md` | 5 |

Teto: verificação vermelha limita a 70; qualquer falha eliminatória do
`CHALLENGE.md` (seção 14) limita a 50. R1 só passa de 20 com a matriz de falha
de infraestrutura verde para todo ponto de entrada que o PR toca.

## Git e PR

- Branch a partir do `main` atualizado: `feat/…`, `fix/…`, `refactor/…`, `docs/…`.
- Conventional commits em português, minúsculas, sem acento:
  `feat: abre e consulta wallets`. Corpo explica o porquê, não o como.
- Commits atômicos. Cada um compila e passa em lint, build, unidade e e2e sozinho.
- Nunca faça push no `main` e nunca faça merge. Abra o PR e pare: ele é revisado
  antes do merge.
- Nunca reescreva o histórico do `main`. Numa branch de PR ainda não mergeada,
  reescreva só quando a revisão pedir, com `git push --force-with-lease`.
- Não deixe commit que só corrige outro commit do mesmo PR: incorpore a correção
  no commit original. A exceção é um defeito de comportamento encontrado por
  revisão independente: ele vira commit próprio no topo do PR, com a reprodução
  no corpo do commit, para a correção ficar visível na auditoria. Ajuste de
  forma, nome ou estilo pedido na revisão continua sendo incorporado.
- Toda afirmação do PR sobre algo verificado precisa de um teste que falhe se
  aquilo quebrar.
- A descrição do PR segue `.github/pull_request_template.md`.
