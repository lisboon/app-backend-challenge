# Teste de carga

**O que medi:** como o serviço se comporta com a carga
concentrada numa wallet, distribuída entre wallets, com reenvios e pela fila;
qual é o modo de falha acima da capacidade; e o que a busca contínua de lotes
da outbox ([arquitetura](../ARCHITECTURE.md#outbox-11))
mudou em relação à versão anterior.

**Resultado:** nenhuma rodada perdeu ou duplicou dinheiro: 302 de 302
wallets reconciliadas em todas. A hot wallet é serial e falha acima da
capacidade com 503 rápido e sem efeito. A busca contínua cortou o lag da outbox
pela metade e custou vazão na hot wallet. Tudo roda numa máquina só, com o SQS
emulado: os números comparam cenários e versões, não medem produção.

## Reproduzir

```sh
bun run test:load
```

Precisa só de Docker e Bun. Sobe uma stack isolada (projeto `wager-load`,
imagem `wagering-processor:load`, volume próprio, portas 3100–3102, 3201–3202
e 4700), roda os cenários, confere as wallets e derruba a stack, inclusive
quando a subida falha no meio. Leva de três a quatro minutos. As esperas têm
prazo (300 s para a fila, 120 s para a outbox), e estourar um prazo encerra com
erro.

**Referência medida:** versão atual no commit `697b64f`; versão anterior no
`058d827`. **Data:** 2026-10-26. **Dados brutos:** as tabelas de cada rodada
estão no fim deste documento.

## Ambiente

| Item | Configuração |
|---|---|
| Host | Intel Core i5-12400F (6 núcleos, 12 threads), 15,8 GB, Windows 11 Pro |
| Containers | Docker Desktop 29.8.1 (WSL2) com 8 GB e 12 CPUs; Compose 5.5.1 |
| Aplicação | Bun 1.4.2; 3 instâncias da API e 2 workers; `CONSUMER_CONCURRENCY` 10 |
| Banco | PostgreSQL 18.6; `DATABASE_POOL_MAX` 15 por processo |
| Broker | LocalStack 4.12 (SQS emulado) |
| Gerador | na mesma máquina, fora dos containers, disputando a mesma CPU |

## Método

- **Aquecimento:** 100 apostas numa wallet à parte, fora das medições.
- **Modelo de carga:** 50 requisições em voo (150 no cenário de sobrecarga),
  em rodízio entre as 3 APIs. É carga fechada: mede a vazão sustentada e a
  latência com fila de espera, não a resposta a uma taxa de chegada fixa.
- **Amostragem:** latência medida no cliente, da requisição à resposta,
  percentis sobre todas as amostras do cenário. Na fila, a latência é a do
  processamento no worker, tirada do histograma, por isso aparece como limite
  de bucket.
- **Repetições:** três rodadas da versão atual e duas da anterior, intercaladas,
  conferindo antes de cada uma que nenhum outro container estava rodando. Duas
  rodadas anteriores foram descartadas: vieram até 70% mais lentas, e os
  containers de uma suíte de testes de outro projeto estavam ativos na máquina
  logo em seguida, sem que eu tivesse conferido antes de rodar.
- **Retries:** o gerador não reenvia; 503 conta como erro.
- **Conclusão:** o runner sai com código 1 se qualquer wallet divergir.

| Cenário | Volume e distribuição | Concorrência | Hipótese |
|---|---|---|---|
| Hot wallet | 2.000 `BET` de 1,00 numa wallet | 50 | serial pelo lock; vazão limitada pela duração da transação |
| Hot wallet sobrecarregada | o mesmo | 150 | acima da capacidade, 503 rápido, sem corrupção |
| Wallets distribuídas | 2.000 em 100 wallets | 50 | sem disputa de lock, vazão maior |
| Reenvios | 1.600 únicas e 400 reenvios idênticos, em 100 wallets | 50 | replay mais barato que aposta nova, sem débito duplicado |
| Fila | 2.000 mensagens em 100 wallets, lotes de envio de 10 | 20 leitores | mais lenta que a HTTP, pela ida extra ao SQS |

## Verificação de correção

| Verificação | Fonte independente | Critério |
|---|---|---|
| Saldo e ledger | `POST /wallets/:id/reconciliation` de cada wallet usada | consistente em todas |
| Efeito único | saldo esperado a partir das respostas: inicial menos as 201 que não foram replay, em centavos inteiros | igual ao saldo de cada wallet |
| Duplicatas | 400 reenvios com a mesma chave e corpo | `idempotentReplay` em todos, sem débito |
| Resultados ambíguos | respostas 503 | nenhum efeito: o saldo esperado as descarta e bate |

**Verificação do próprio runner:** uma divergência proposital de um centavo no
saldo esperado fez o runner sair com 1 e derrubar a stack.

## Resultados

Rodada de referência da versão atual (a segunda de três):

| Cenário | Vazão | p50 / p95 / p99 (ms) | Erro | Conflitos de lock | Lag máx. da outbox | Outbox zerada após |
|---|---|---|---|---|---|---|
| Hot wallet | 61 op/s | 981 / 1.581 / 1.904 | 0,2% (4 × 503) | 0 | 2,1 s | 0,9 s |
| Hot wallet, 150 concorrentes | 106 op/s | 1.223 / 2.178 / 2.858 | 33,2% (664 × 503) | 0 | 1,6 s | 0,7 s |
| Wallets distribuídas | 335 op/s | 141 / 228 / 294 | 0% | 0 | 8,5 s | 8,7 s |
| Reenvios | 364 op/s | 128 / 251 / 310 | 0% | 0 | 6,9 s | 7,2 s |
| Fila | 106 mensagens/s | ≤ 250 / ≤ 250 / ≤ 500 | — | 0 | 10,7 s | 6,6 s |

Comparação entre versões:

| Cenário | Métrica | Atual (3 rodadas) | Anterior (2 rodadas) |
|---|---|---|---|
| Wallets distribuídas | lag máx. da outbox | 8,5 a 10,8 s | 19,2 a 19,5 s |
| Reenvios | lag máx. da outbox | 4,3 a 6,9 s | 14,2 a 14,7 s |
| Fila | lag máx. da outbox | 8,8 a 10,7 s | 14,7 a 20,4 s |
| Hot wallet | lag máx. da outbox | 2,1 a 3,0 s | 6,9 a 11,2 s |
| Hot wallet | vazão | 40 a 87 op/s (média 63) | 79 a 83 op/s |
| Hot wallet | 503 com 50 concorrentes | 0,2% a 8,2% | 0% |
| Wallets distribuídas | vazão | 232 a 347 op/s | 320 a 350 op/s |
| Fila | vazão | 99 a 113 mensagens/s | 98 a 114 mensagens/s |

## Interpretação

| Observação | Evidência | Explicação | O que não medi |
|---|---|---|---|
| A hot wallet faz de 40 a 87 op/s | vazão do cenário 1 | cada aposta espera o lock da anterior; com 50 em voo, a fila de espera dá o p50 perto de 1 s | quanto cada etapa da transação pesa |
| Acima da capacidade, 503 com mediana de 1.003 ms | status e mediana dos 503 | cerca de 50 requisições por API contra um pool de 15; quem não pega conexão falha no `connectionTimeoutMillis` de 1 s. `lock_conflicts_total` zerado descarta o `lock_timeout` de 2 s | |
| Wallets distribuídas fazem de 232 a 347 op/s | cenário 3 | wallets diferentes não compartilham lock | onde fica o gargalo: CPU, pool ou LocalStack |
| A fila faz cerca de um terço da HTTP | cenário 5 | uma mensagem por `ReceiveMessage` e o `DeleteMessage`: duas idas ao SQS por mensagem ([arquitetura](../ARCHITECTURE.md#fila-10)) | o mesmo no SQS real |
| O lag da outbox caiu pela metade | comparação entre versões | com o intervalo fixo, cada worker entregava no máximo 100 eventos a cada 500 ms, abaixo dos mais de 500 eventos/s que as apostas produzem | |
| A hot wallet perdeu vazão na versão atual | comparação entre versões | o publicador trava só linhas da outbox e a aposta só insere linhas novas, então não é disputa de lock; a consulta do lote calcula funções de janela sobre todos os pendentes e, rodando sem pausa, ocupa CPU do PostgreSQL, e a hot wallet, serial, sente primeiro | a medição direta da CPU do PostgreSQL durante a hot wallet |
| Uma rodada saiu com p50 de 58 ms e p95 de 1,97 s na hot wallet | rodada 3 | distribuição bimodal: as requisições que pegaram conexão passaram rápido, e as outras esperaram o timeout | |

A variação entre rodadas é grande porque tudo divide a mesma máquina, mas a
ordem entre os cenários e a direção da comparação se mantiveram em todas.

## Limites e próximo experimento

**Limites:** host único compartilhado entre banco, emulador, aplicação e
gerador; SQS emulado; rodadas curtas (2.000 operações por cenário); carga
fechada, sem taxa de chegada controlada; sem cenário de falha e recuperação sob
carga.

**Próximo experimento:** tornar a consulta do lote da outbox proporcional ao
lote, e não ao total pendente, e repetir a comparação intercalada. Se a
hipótese da CPU estiver certa, a hot wallet volta a cerca de 80 op/s sem 503 a
50 concorrentes, e o lag fica como está hoje.

## Rodadas

Vazão, latência p50 / p95 / p99 (ms), erro, lag máximo da outbox (s) e tempo
até a outbox zerar (s).

| Rodada | Cenário | Vazão | Latência | Erro | Lag | Zerada |
|---|---|---|---|---|---|---|
| atual 1 | hot wallet | 40 | 1.414 / 2.817 / 3.889 | 4,65% | 2,4 | 0,5 |
| atual 1 | hot wallet, 150 | 105 | 1.181 / 2.214 / 2.643 | 39,25% | 1,6 | 1,1 |
| atual 1 | distribuídas | 232 | 178 / 467 / 656 | 0% | 10,8 | 11,2 |
| atual 1 | reenvios | 139 | 248 / 1.105 / 1.777 | 0,50% | 4,3 | 4,5 |
| atual 1 | fila | 99 | ≤ 250 / ≤ 500 / ≤ 500 | — | 8,8 | 5,0 |
| atual 2 | hot wallet | 61 | 981 / 1.581 / 1.904 | 0,20% | 2,1 | 0,9 |
| atual 2 | hot wallet, 150 | 106 | 1.223 / 2.178 / 2.858 | 33,20% | 1,6 | 0,7 |
| atual 2 | distribuídas | 335 | 141 / 228 / 294 | 0% | 8,5 | 8,7 |
| atual 2 | reenvios | 364 | 128 / 251 / 310 | 0% | 6,9 | 7,2 |
| atual 2 | fila | 106 | ≤ 250 / ≤ 250 / ≤ 500 | — | 10,7 | 6,6 |
| atual 3 | hot wallet | 87 | 58 / 1.971 / 2.616 | 8,15% | 3,0 | 1,4 |
| atual 3 | hot wallet, 150 | 108 | 1.275 / 1.997 / 2.418 | 18,25% | 1,8 | 1,5 |
| atual 3 | distribuídas | 347 | 133 / 246 / 279 | 0% | 9,0 | 9,2 |
| atual 3 | reenvios | 370 | 127 / 242 / 315 | 0% | 6,6 | 6,7 |
| atual 3 | fila | 113 | ≤ 250 / ≤ 250 / ≤ 250 | — | 9,7 | 6,9 |
| anterior 1 | hot wallet | 79 | 816 / 1.187 / 1.285 | 0% | 6,9 | 6,5 |
| anterior 1 | hot wallet, 150 | 108 | 1.339 / 1.930 / 2.300 | 22,30% | 2,3 | 2,2 |
| anterior 1 | distribuídas | 320 | 147 / 246 / 290 | 0% | 19,2 | 19,7 |
| anterior 1 | reenvios | 320 | 146 / 285 / 372 | 0% | 14,2 | 14,6 |
| anterior 1 | fila | 98 | ≤ 250 / ≤ 250 / ≤ 500 | — | 20,4 | 20,2 |
| anterior 2 | hot wallet | 83 | 747 / 1.096 / 1.383 | 0% | 11,2 | 11,5 |
| anterior 2 | hot wallet, 150 | 108 | 1.318 / 1.980 / 2.428 | 21,35% | 6,8 | 7,1 |
| anterior 2 | distribuídas | 350 | 139 / 208 / 249 | 0% | 19,5 | 19,9 |
| anterior 2 | reenvios | 345 | 135 / 259 / 332 | 0% | 14,7 | 15,0 |
| anterior 2 | fila | 114 | ≤ 250 / ≤ 250 / ≤ 500 | — | 14,7 | 14,9 |

Conflitos de lock: zero em todas as rodadas e cenários.
