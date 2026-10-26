# Teste de carga

`bun run test:load` sobe uma stack isolada do Compose (projeto `wager-load`,
volume próprio e imagem própria, `wagering-processor:load`), com **3 instâncias
da API e 2 workers**, roda os cenários, confere saldo e ledger de toda wallet
usada e derruba a stack. Não precisa de nada além do Docker e do Bun, e não toca
no ambiente de desenvolvimento.

A stack é derrubada também quando a subida falha no meio, e as esperas têm
prazo: 300 s para os workers consumirem a fila e 120 s para a outbox zerar.
Estourar um prazo encerra a execução com erro, em vez de deixar o processo
preso.

## Ambiente

| | |
|---|---|
| CPU | Intel Core i5-12400F, 6 núcleos, 12 threads |
| RAM | 15,8 GB na máquina; 8 GB e 12 CPUs para o Docker Desktop |
| Sistema | Windows 11 Pro, Docker Desktop 29.8.1 (WSL2), Compose 5.5.1 |
| Stack | Bun 1.4.2, PostgreSQL 18.6, LocalStack 4.12; `DATABASE_POOL_MAX` 15 e `CONSUMER_CONCURRENCY` 10 por processo |

O cliente de carga roda na mesma máquina, fora dos containers. Os números
valem para comparar cenários e versões entre si; não são capacidade de
produção, porque PostgreSQL, LocalStack, 5 processos da aplicação e o cliente
disputam a mesma CPU, e o SQS é emulado.

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
- **Comparação entre versões:** execuções intercaladas da versão atual e da
  anterior, na mesma máquina e na mesma janela, conferindo antes de cada uma
  que nenhum container de terceiros estava rodando. Duas execuções feitas
  enquanto outra suíte de testes ocupava a máquina foram descartadas: vieram
  até 70% mais lentas e não medem a aplicação.

## Resultado

Execução de referência da versão atual (a segunda de três; as faixas estão na
última seção):

| Cenário | Vazão (op/s) | p50 (ms) | p95 (ms) | p99 (ms) | Erro | Status | Conflitos de lock | Lag máx. da outbox | Outbox zerada após |
|---|---|---|---|---|---|---|---|---|---|
| hot wallet | 61 | 981 | 1.581 | 1.904 | 0,2% | 201: 1.996; 503: 4 (mediana 1.004 ms) | 0 | 2,1 s | 0,9 s |
| hot wallet, 150 concorrentes | 106 | 1.223 | 2.178 | 2.858 | 33,2% | 201: 1.336; 503: 664 (mediana 1.003 ms) | 0 | 1,6 s | 0,7 s |
| wallets distribuídas | 335 | 141 | 228 | 294 | 0% | 201: 2.000 | 0 | 8,5 s | 8,7 s |
| 20% de reenvios | 364 | 128 | 251 | 310 | 0% | 201: 2.000, sendo 400 replays | 0 | 6,9 s | 7,2 s |
| fila, wallets distribuídas | 106 mensagens/s | ≤ 250 | ≤ 250 | ≤ 250 | — | — | 0 | 10,7 s | 6,6 s |

A latência da fila é a do processamento de cada mensagem no worker, tirada do
histograma; por isso aparece como limite de bucket.

**Correção:** nas cinco execuções da comparação, reconciliação consistente em
**302 de 302 wallets**, e o saldo de cada uma igual ao esperado pelas
respostas. Nenhuma resposta 500, nenhum débito duplicado pelos 400 reenvios.

## Publicação contínua da outbox: o que ganhou e o que custou

A versão atual faz o publicador buscar o próximo lote na hora quando o
anterior veio cheio (100 eventos), em vez de esperar os 500 ms do intervalo.
A comparação intercalada com a versão anterior mostra o efeito:

| Cenário | Métrica | Atual (3 execuções) | Anterior (2 execuções) |
|---|---|---|---|
| wallets distribuídas | lag máx. da outbox | 8,5 a 10,8 s | 19,2 a 19,5 s |
| 20% de reenvios | lag máx. da outbox | 4,3 a 6,9 s | 14,2 a 14,7 s |
| fila | lag máx. da outbox | 8,8 a 10,7 s | 14,7 a 20,4 s |
| hot wallet | vazão | 40 a 87 op/s (média 63) | 79 a 83 op/s |
| hot wallet | 503 com 50 concorrentes | 0,2% a 8,2% | 0% |
| wallets distribuídas | vazão | 232 a 347 op/s | 320 a 350 op/s |
| fila | vazão | 99 a 113 mensagens/s | 98 a 114 mensagens/s |

- **O lag cai pela metade.** Antes, o publicador entregava no máximo 100 eventos
  por intervalo de 500 ms por worker, abaixo dos mais de 500 eventos por
  segundo que as apostas produzem; sob carga sustentada, o lag cresceria sem
  limite.
- **A hot wallet paga por isso.** Não é disputa de lock: o publicador trava só
  linhas da outbox, e a aposta só insere linhas novas. É disputa de recurso. A
  consulta que escolhe o lote calcula funções de janela sobre todos os eventos
  pendentes, e rodando sem pausa ela ocupa CPU do PostgreSQL, que nesta máquina
  é a mesma da aplicação. A hot wallet é serial (cada aposta espera a
  anterior), então todo milissegundo a mais por transação vira vazão a menos e
  mais requisições sem conexão livre, que saem como 503 depois de 1 s. Nas
  wallets distribuídas e na fila a diferença fica dentro do ruído.
- **Mantivemos a mudança.** O enunciado pede outbox lag sob controle, e lag que
  cresce sem limite atrasa todo consumidor de eventos; a perda na hot wallet é
  vazão, não correção: os 503 levam `Retry-After`, não têm efeito e podem ser
  reenviados com a mesma chave. O próximo passo, se a hot wallet importar mais,
  é tornar a consulta do lote proporcional ao lote, e não ao total pendente, em
  vez de voltar a limitar o publicador.

## Interpretação

- **A hot wallet é serial por desenho.** Cada operação espera o lock da
  anterior (seção 6 do `ARCHITECTURE.md`). Com 50 em voo, a fila de espera
  explica o p50 perto de 1 s. Numa execução a distribuição saiu bimodal: p50 de
  58 ms e p95 de 1,97 s, com 8% de 503. Wallets diferentes não disputam lock, e o mesmo
  volume distribuído sobe para 230 a 350 op/s, com p50 de 130 a 180 ms.
- **Acima da capacidade, a falha é 503 rápido, não corrupção.** Quem espera o
  lock da wallet segura uma conexão do pool. Com 150 concorrentes, cerca de 50
  por API contra um pool de 15, as requisições sem conexão falham depois do
  `connectionTimeoutMillis` de 1 s: a mediana dos 503 é 1.003 ms, e
  `lock_conflicts_total` continuou zero, o que descarta timeout de lock (2 s).
  Os 503 levam `Retry-After`, não têm efeito e podem ser reenviados com a mesma
  chave. As alavancas, se a hot wallet precisar de mais fôlego, são o pool por
  processo (respeitando processos × pool ≤ `max_connections`) ou serializar por
  wallet antes de pegar a conexão.
- **Reenvios custam menos que apostas novas.** O replay lê a transação gravada
  e devolve o desfecho sem mover saldo nem gravar outbox.
- **A fila é mais lenta que a HTTP neste ambiente.** São 20 leitores (2 workers
  × 10), cada um com uma mensagem por `ReceiveMessage`, mais o
  `DeleteMessage`: duas idas ao LocalStack por mensagem, além da transação. É o
  custo da decisão de uma mensagem por receive para preservar a ordem do grupo
  (seção 11). Escala com `CONSUMER_CONCURRENCY` e com mais workers.
- **A outbox atrasa sob carga e se recupera.** Cada aposta grava dois eventos,
  e o publicador envia um `SendMessage` por evento, em série dentro da wallet.
  O lag chega a cerca de 11 s e zera em até 11 s depois que a carga para, sem
  perder evento: o evento já está confirmado no banco.
- **Conflitos de lock zerados.** Nenhuma transação estourou o `lock_timeout`
  de 2 s nem caiu em deadlock em nenhum cenário.

## Variação entre execuções

| Cenário | Faixa nas três execuções da versão atual |
|---|---|
| hot wallet | 40 a 87 op/s; 503 em todas (0,2% a 8,2%) |
| hot wallet, 150 concorrentes | 105 a 108 op/s; 18% a 39% de 503 |
| wallets distribuídas | 232 a 347 op/s |
| 20% de reenvios | 139 a 370 op/s; 10 respostas 503 na execução mais lenta |
| fila | 99 a 113 mensagens/s |

A variação é grande porque tudo divide a mesma máquina; a ordem entre os
cenários se manteve em todas. Todas fecharam com a reconciliação consistente e
o saldo esperado em todas as wallets. O runner sai com código 1 se qualquer
wallet divergir; isso foi provado com uma divergência proposital de um centavo
no saldo esperado.
