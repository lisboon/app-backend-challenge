# Teste de carga

`bun run test:load` sobe uma stack isolada do Compose (projeto `wager-load`,
volume próprio), com **3 instâncias da API e 2 workers**, roda os cenários,
confere saldo e ledger de toda wallet usada e derruba a stack. Não precisa de
nada além do Docker e do Bun, e não toca no ambiente de desenvolvimento.

## Ambiente

| | |
|---|---|
| CPU | Intel Core i5-12400F, 6 núcleos, 12 threads |
| RAM | 15,8 GB na máquina; 8 GB e 12 CPUs para o Docker Desktop |
| Sistema | Windows 11 Pro, Docker Desktop 29.8.1 (WSL2), Compose 5.5.1 |
| Stack | Bun 1.4.2, PostgreSQL 18.6, LocalStack 4.12; `DATABASE_POOL_MAX` 15 e `CONSUMER_CONCURRENCY` 10 por processo |

O cliente de carga roda na mesma máquina, fora dos containers. Os números
valem para comparar cenários entre si; não são capacidade de produção, porque
PostgreSQL, LocalStack, 5 processos da aplicação e o cliente disputam a mesma
CPU, e o SQS é emulado.

## Metodologia

- **Aquecimento:** 100 apostas numa wallet à parte, fora das medições.
- **Cada cenário:** 2.000 operações `BET` de 1,00, com 50 requisições em voo
  distribuídas em rodízio entre as 3 APIs. A latência é medida no cliente, da
  requisição à resposta. Entre um cenário e o seguinte o runner espera a
  outbox zerar, para um cenário não carregar a publicação do anterior.
- **Cenários:**
  1. hot wallet: todas as apostas numa wallet;
  2. hot wallet com 150 concorrentes: o mesmo, acima da capacidade, para
     mostrar o modo de falha;
  3. wallets distribuídas: 100 wallets;
  4. 20% de reenvios: 1.600 apostas únicas e 400 reenvios idênticos (mesma
     chave e corpo), embaralhados, em 100 wallets;
  5. fila: as mesmas 2.000 apostas em 100 wallets por `wager-transactions.fifo`,
     enviadas em lotes de 10; o tempo vai do primeiro envio até os workers
     contarem 2.000 mensagens processadas.
- **Métricas lidas do Prometheus de cada processo:** `lock_conflicts_total`
  (soma), `outbox_lag_seconds` (máximo, amostrado a cada 250 ms) e o
  histograma `wager_message_processing_seconds`.
- **Verificação final:** reconciliação de toda wallet usada e comparação do
  saldo com o esperado pelas respostas recebidas (saldo inicial menos as
  respostas 201 que não foram replay). O saldo é comparado em centavos
  inteiros, sem `number`.

## Resultado

Execução de referência (a terceira de quatro com esta metodologia; as faixas
das quatro estão na última seção):

| Cenário | Vazão (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Erro | Status | Conflitos de lock | Lag máx. da outbox | Outbox zerada após |
|---|---|---|---|---|---|---|---|---|---|
| hot wallet | 61 | 1.010 | 1.625 | 1.947 | 0% | 201: 2.000 | 0 | 4,1 s | 3,7 s |
| hot wallet, 150 concorrentes | 105 | 1.260 | 2.131 | 2.561 | 34,6% | 201: 1.309; 503: 691 (mediana 1.003 ms) | 0 | 3,8 s | 3,7 s |
| wallets distribuídas | 294 | 155 | 287 | 471 | 0% | 201: 2.000 | 0 | 21,1 s | 21,5 s |
| 20% de reenvios | 443 | 109 | 187 | 243 | 0% | 201: 2.000, sendo 400 replays | 0 | 10,6 s | 11,2 s |
| fila, wallets distribuídas | 123 mensagens/s | ≤ 250 | ≤ 250 | ≤ 250 | — | — | 0 | 11,6 s | 11,7 s |

A latência da fila é a do processamento de cada mensagem no worker, tirada do
histograma; por isso aparece como limite de bucket.

**Correção:** reconciliação consistente em **302 de 302 wallets**, e o saldo
de cada uma igual ao esperado pelas respostas. Nenhuma resposta 500, nenhum
débito duplicado pelos 400 reenvios.

## Interpretação

- **A hot wallet é serial por desenho.** Cada operação espera o lock da
  anterior (seção 6 do `ARCHITECTURE.md`): de 61 a 76 operações por segundo,
  ou 13 a 16 ms por transação nesta máquina. Com 50 em voo, a fila de espera
  explica o p50 de 0,7 a 1 s. Wallets diferentes não disputam lock, e o mesmo
  volume distribuído sobe para 280 a 400 op/s, com p50 de 120 a 170 ms.
- **Acima da capacidade, a falha é 503 rápido, não corrupção.** Quem espera o
  lock da wallet segura uma conexão do pool. Com 150 concorrentes, cerca de 50
  por API contra um pool de 15, as requisições sem conexão falham depois do
  `connectionTimeoutMillis` de 1 s: a mediana dos 503 é 1.003 ms, e
  `lock_conflicts_total` continuou zero, o que descarta timeout de lock (2 s).
  Os 503 levam `Retry-After`, não têm efeito e podem ser reenviados com a mesma
  chave. Com 50 concorrentes, duas das quatro execuções tiveram respostas no
  mesmo limite: 38 e 9 de 2.000 (1,9% e 0,45%), também com mediana de 1 s. Se a hot wallet precisar de mais fôlego, as alavancas são o
  pool por processo (respeitando processos × pool ≤ `max_connections`) ou
  serializar por wallet antes de pegar a conexão; não fizemos, porque o
  comportamento atual já é seguro.
- **Reenvios custam menos que apostas novas.** O replay lê a transação gravada
  e devolve o desfecho sem mover saldo nem gravar outbox, o que puxa a vazão do
  cenário para cima.
- **A fila é mais lenta que a HTTP neste ambiente.** São 20 leitores (2 workers
  × 10), cada um com uma mensagem por `ReceiveMessage`, mais o
  `DeleteMessage`: duas idas ao LocalStack por mensagem, além da transação. É o
  custo da decisão de uma mensagem por receive para preservar a ordem do grupo
  (seção 11). Escala com `CONSUMER_CONCURRENCY` e com mais workers.
- **A outbox atrasa sob carga e se recupera.** Cada aposta grava dois eventos,
  e o publicador envia um `SendMessage` por evento, em série dentro da wallet.
  Na execução de referência, com 294 op/s, a produção passa de 500 eventos por
  segundo, acima do que o
  publicador entrega contra o LocalStack, e o lag chega a 21 s. Ele zera em até
  22 s depois que a carga para, sem perder evento. A mesma vazão de 400 op/s,
  numa das execuções, levou o lag a 13 s: o gargalo varia com o LocalStack. Lag não é perda: o evento já
  está confirmado no banco. As alavancas são o intervalo de poll, o tamanho do
  lote e o paralelismo entre wallets do publicador.
- **Conflitos de lock zerados.** Nenhuma transação estourou o `lock_timeout`
  de 2 s nem caiu em deadlock em nenhum cenário.

## Variação entre execuções

| Cenário | Faixa nas quatro execuções |
|---|---|
| hot wallet | 61 a 76 op/s; 503 em duas execuções (38 e 9) |
| hot wallet, 150 concorrentes (nas duas últimas) | 105 a 107 op/s; 24% a 35% de 503 |
| wallets distribuídas | 280 a 400 op/s |
| 20% de reenvios | 314 a 443 op/s |
| fila | 104 a 129 mensagens/s |

A variação é grande porque tudo divide a mesma máquina; a ordem entre os
cenários se manteve em todas. As quatro fecharam com a reconciliação
consistente e o saldo esperado em todas as wallets. O runner sai com código 1
se qualquer wallet divergir; isso foi provado com uma divergência proposital de
um centavo no saldo esperado.
