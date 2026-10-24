# Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming. O enunciado está em
[`CHALLENGE.md`](CHALLENGE.md) e as decisões em [`ARCHITECTURE.md`](ARCHITECTURE.md).

> Em construção. Este README lista só o que já existe; infraestrutura
> (PostgreSQL, SQS) e endpoints de negócio entram nos próximos incrementos.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4.x

## Comandos

```bash
bun install          # dependências
bun run start        # sobe a API (porta 3000, ou PORT)
bun run dev          # idem, com watch
bun run test         # testes de unidade (tests/unit)
bun run test:e2e     # testes e2e da camada HTTP (tests/e2e)
bun run lint         # oxlint, incluindo as regras de boundary entre camadas
bun run build        # checagem de tipos e build
```

O CI (`.github/workflows/ci.yml`) roda os mesmos comandos em Ubuntu a cada push
e pull request.
