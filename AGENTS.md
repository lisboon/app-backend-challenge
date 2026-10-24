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

## Arquitetura

- Contextos em `src/modules/<contexto>/` com `domain/`, `usecase/`, `gateway/`,
  `repository/`, `factory/` e `event/`. Borda em `src/infra/`. Pasta só nasce
  com arquivo.
- O lint (`.oxlintrc.json`) impõe as fronteiras: `domain/` é TypeScript puro;
  `usecase/` não importa framework, ORM nem adaptador; `domain/`, `usecase/` e
  `gateway/` não importam outro contexto. Contextos conversam por uma porta
  declarada por quem consome, ligada na `factory/`.
- Casos de uso são montados pela factory do contexto e expostos ao Nest por
  `useFactory`. Nunca use `@Injectable` em `usecase/`.
- Todo acesso ao banco passa pelo `TransactionManager`. Gateways recebem o
  contexto da transação como parâmetro obrigatório.

## Nomes

- Caso de uso: `usecase/<ação>/<ação>.usecase.ts` e `<ação>.usecase.dto.ts`,
  com `{Ação}UseCaseInputDto`, `{Ação}UseCaseOutputDto` e
  `{Ação}UseCaseInterface`.
- Gateway: `<nome>.gateway.ts`, com métodos `create`, `update`, `findById` e a
  transação como último parâmetro.
- Repositório: `<nome>.repository.ts`, `<nome>.model.ts` (`defineEntity`) e
  `<nome>.model.mapper.ts`.
- Entidade: `<nome>.entity.ts`, com construtor privado e factories estáticas
  (`create`, `open`, `rehydrate`). `rehydrate` não revalida transições.

## Regras de código

- Linha em branco depois do último import. Imports em dois blocos separados por
  linha em branco: primeiro pacotes externos, depois caminhos relativos; dentro
  de cada bloco, na ordem em que o resto do projeto já usa.
- Linha em branco entre membros de classe (construtor, métodos).
- `if` sempre com chaves, mesmo de uma linha.
- Tipo de retorno explícito em toda função e método de `src/`.
- Textos em português com acentuação correta em código, mensagens de erro, nomes
  de teste e documentação. Só as mensagens de commit ficam sem acento.
- Teste de uma classe existente entra no spec que já existe para ela.
- Nome de caso de uso inclui o agregado: `CreateWalletUseCase`,
  `FindWalletByIdUseCase`.
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
`CHALLENGE.md` (seção 14) limita a 50.

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
  no commit original.
- Toda afirmação do PR sobre algo verificado precisa de um teste que falhe se
  aquilo quebrar.
- A descrição do PR segue `.github/pull_request_template.md`.
