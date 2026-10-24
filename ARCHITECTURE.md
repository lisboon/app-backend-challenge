# Decisões de arquitetura

Registro das escolhas estruturais e do que foi abandonado. O enunciado pede
decisões justificadas; este arquivo é onde elas ficam.

## Camadas por módulo

Cada módulo de negócio em `src/domain/<módulo>/` tem cinco pastas:

| Pasta | Papel |
|---|---|
| `domain/` | entidades e objetos de valor. TypeScript puro, sem NestJS e sem ORM |
| `usecase/` | um caso de uso por operação, recebendo entradas simples |
| `gateway/` | as portas: interfaces de repositório e de serviço externo |
| `repository/` | o adaptador que implementa a porta contra o banco |
| `event/` | os eventos de integração que o módulo publica |
