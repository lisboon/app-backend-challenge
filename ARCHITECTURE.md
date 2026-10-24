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
