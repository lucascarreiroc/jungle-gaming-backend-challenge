# ARCHITECTURE.md — Distributed Wagering Processor

## 1. Visão geral da solução

O sistema é modelado em três camadas:

- **Domain** (`src/domain`): entidades e value objects puros, sem dependência
  de framework, ORM ou infraestrutura. `Money`, `Wallet`, `WagerTransaction`,
  `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`.
- **Application** (`src/application`): casos de uso e portas (interfaces) que
  a camada de domínio usa para falar com o mundo externo, sem saber como esse
  mundo é implementado (`ports.ts`).
- **Infrastructure/Interfaces** (`src/infrastructure`, `src/interfaces`):
  implementações concretas (Postgres via `pg`, controllers HTTP NestJS,
  consumer SQS) que implementam as portas.

Essa separação existe para permitir testar o domínio e os casos de uso
inteiramente em memória (testes de unidade), sem subir Postgres nem
LocalStack — e para trocar a implementação de persistência sem tocar nas
regras de negócio.

## 2. Money — por que Decimal, não number

`amount` nunca passa por `number`/`float`/`double` em nenhum ponto do
pipeline: chega como string decimal na API, é convertido para `Decimal`
(biblioteca `decimal.js`) no domínio, e é persistido como `NUMERIC(19,2)` no
Postgres — que também não usa ponto flutuante binário internamente.

A escala é fixada em exatamente 2 casas decimais na fronteira (`Money.from`),
o que elimina qualquer ambiguidade de arredondamento: nunca fazemos "quase
25.00", sempre é exatamente "25.00" ou a operação é rejeitada.

## 3. Estratégia de concorrência

A unidade de concorrência é a `walletId`, conforme exigido na seção 8 do
desafio. A estratégia escolhida foi **optimistic locking com retry limitado**,
não pessimistic locking (`SELECT ... FOR UPDATE`), pelos seguintes motivos:

- Apostas são operações de curta duração e alta frequência — lock pessimista
  aumentaria a contenção em wallets "quentes" (jogadores muito ativos) sem
  necessidade, já que a maioria das tentativas não colide de fato.
- O optimistic lock (coluna `version`, `UPDATE ... WHERE id = ? AND version = ?`)
  é barato: falha rápido (0 linhas afetadas) e permite ao use case decidir o
  que fazer — reler e retentar, até `MAX_OPTIMISTIC_LOCK_RETRIES = 5`.
- Cada wallet é serializada **apenas contra si mesma** — wallets diferentes
  processam em paralelo sem qualquer lock compartilhado entre elas, o que
  responde diretamente ao requisito "não usar lock global compartilhado por
  todas as wallets".

**Trade-off assumido**: sob contenção extrema numa única wallet (muitas
requisições simultâneas para o mesmo jogador), o retry pode esgotar as 5
tentativas e a transação é marcada `FAILED` com `INFRA_TRANSIENT_FAILURE`,
sinalizando ao provedor para reenviar. Isso é aceitável no domínio de apostas
(um jogador não faz 5+ apostas simultâneas na prática), mas seria uma escolha
diferente para, por exemplo, uma wallet corporativa recebendo milhares de
transações por segundo — ali um lock pessimista com fila explícita seria
mais previsível.

### Cenário obrigatório (seção 8)

Saldo inicial 100.00, duas apostas de 80.00 simultâneas:

1. Ambas as requisições leem a wallet com `version = 1`, `balance = 100.00`.
2. Ambas aplicam `wallet.debit(80.00)` em memória — ambas calculam
   `balance = 20.00`, `version = 2` localmente (isso é seguro porque é
   estado em memória de cada processo, não compartilhado).
3. Ambas tentam `UPDATE wallets SET balance=20.00, version=2 WHERE id=? AND version=1`.
4. O Postgres serializa as duas UPDATEs. A primeira a chegar afeta 1 linha e
   grava `version=2`. A segunda, avaliada depois, não encontra mais nenhuma
   linha com `version=1` — afeta 0 linhas.
5. A primeira segue o caminho de sucesso (ledger, outbox, `PROCESSED`).
6. A segunda recebe `updated: false`, re-lê a wallet (agora com `version=2`,
   `balance=20.00`), tenta `wallet.debit(80.00)` de novo — e agora
   `InsufficientBalanceError` é lançado porque `20.00 < 80.00`. A transação é
   marcada `REJECTED` com `BUSINESS_INSUFFICIENT_BALANCE`.

Resultado: exatamente uma `PROCESSED`, uma `REJECTED`, saldo final `20.00`,
um único lançamento de débito no ledger. Ver `test/unit/wallet.spec.ts` para
a demonstração do comportamento do domínio isoladamente, e
`test/concurrency/` para o plano de teste com paralelismo real (ver seção 8
deste documento sobre o que está implementado vs. planejado).

## 4. Idempotência

Fonte da verdade: `UNIQUE (provider_id, idempotency_key)` no schema
(`wager_transactions`), não cache em memória. O fluxo:

1. `SELECT` por `(provider_id, idempotency_key)` dentro da mesma transação
   que fará o `INSERT` — se existir, comparamos `payloadHash`.
2. Payload igual → resposta de replay (`idempotentReplay: true`), com o
   `status` e o saldo observado *no momento original*, não recalculado.
3. Payload diferente → `IdempotencyConflictError` (409).
4. Se não existir, o `INSERT` segue. Se duas requisições concorrentes com a
   mesma key chegarem verdadeiramente ao mesmo tempo (ambas passam pelo
   SELECT antes de qualquer INSERT committar), o Postgres serializa isso no
   nível de `INSERT`: a segunda transação **bloqueia** até a primeira
   committar, e então recebe um erro de `unique_violation` (SQLSTATE
   `23505`) sobre a constraint `uq_wager_tx_idempotency`. O
   `SubmitWagerTransactionUseCase.execute()` captura especificamente esse
   erro (verificando `err.code === '23505'` e o nome da constraint),
   abre uma nova transação curta, busca a linha vencedora, e devolve a
   mesma resposta de replay que o caminho "feliz" de idempotência devolveria
   — o chamador nunca vê essa corrida como um erro. Isso está coberto pelo
   teste `test/concurrency/wallet-concurrency.spec.ts` ("the same bet
   submitted 50 times in parallel").

`payloadHash` é um SHA-256 do JSON canônico (chaves ordenadas) do
subconjunto de campos de negócio — nunca inclui o header `Idempotency-Key`
em si nem metadados de transporte, conforme especificado. Ver
`computePayloadHash` em `submit-wager-transaction.use-case.ts`.

## 5. Transactional Outbox

Toda mutação financeira (wallet + ledger + transação + eventos) acontece
dentro de uma única transação SQL (`UnitOfWork.run`). Os eventos de
integração são serializados e inseridos na tabela `outbox_messages` **na
mesma transação**, nunca publicados diretamente no SQS durante o caso de
uso — isso é o que garante "nunca publicar eventos antes do commit".

Um worker separado (`OutboxPublisherWorker`) roda periodicamente, faz
`SELECT ... FOR UPDATE SKIP LOCKED` para pegar um lote de mensagens
pendentes sem colidir com outros publishers, publica cada uma no SQS, e
marca `published_at` numa transação curta separada.

**Trade-off documentado explicitamente**: o lock (`SKIP LOCKED`) é liberado
assim que a transação de leitura do lote é confirmada — ele não fica
segurando a linha durante a chamada de rede ao SQS (isso travaria a linha por
todo o tempo da chamada HTTP ao broker, o que é uma prática ruim). Isso
significa que, numa janela pequena, duas instâncias *poderiam* teoricamente
pegar a mesma mensagem em lotes que se sobrepõem no tempo. A segurança final
não vem da exclusividade do lock durante a publicação, e sim do **consumidor
final fazer dedup via Inbox** — publicação duplicada é explicitamente
aceitável pelo desafio ("uma publicação duplicada continua segura para o
consumidor"). Achei importante deixar essa nuance explícita, porque é um erro
comum assumir que `SKIP LOCKED` sozinho garante exclusividade fim-a-fim.

## 6. Inbox e consumo SQS

`InboxMessage` deduplicada por `(consumer_name, message_id)`, PK composta —
dedup persistente, não em memória. O `INSERT ... ON CONFLICT DO NOTHING`
garante que, mesmo com duas instâncias processando a mesma mensagem
simultaneamente (SQS at-least-once), apenas uma prossegue para aplicar o
efeito de negócio.

O `SqsConsumer` (`src/infrastructure/sqs/sqs-consumer.ts`) está implementado
e reutiliza o mesmo `SubmitWagerTransactionUseCase` que o controller HTTP
usa — não existe uma segunda cópia da lógica de negócio para o caminho de
fila. Fluxo:

1. Faz long polling na fila via `ReceiveMessageCommand`.
2. Para cada mensagem, checa o Inbox primeiro (leitura rápida) — se já
   processada, faz ack imediatamente sem tocar no use case de novo.
3. Chama o use case. Três desfechos possíveis:
   - **Sucesso** (`PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`, todos
     retornados normalmente pelo use case, sem lançar exceção) → grava no
     Inbox como processada e faz ack. Uma rejeição de negócio é, do ponto de
     vista do consumer, um resultado "tratado com sucesso": o use case
     rodou até o fim e o resultado está durável no banco.
   - **`DomainError` lançado** (ex.: conflito de idempotência com payload
     divergente) → problema de dados, não de infraestrutura. Grava no Inbox
     e faz ack — reentregar não vai resolver.
   - **Qualquer outro erro** (Postgres fora do ar, timeout de rede) →
     tratado como transitório. **Não** faz ack. A mensagem volta a ficar
     visível após o `VisibilityTimeout` e o SQS reentrega automaticamente.
4. Em `SIGTERM`/`SIGINT` (capturado em `main.ts`), o consumer para de puxar
   mensagens novas e aguarda as que já estão em andamento terminarem (ack ou
   não) antes do processo encerrar — evita matar o processo com trabalho
   pela metade.

**Trade-off documentado explicitamente**: a marcação do `InboxMessage` como
processada acontece em uma transação **separada** da mutação financeira do
use case (que já commita sua própria transação internamente antes do
consumer sequer saber o resultado). Isso significa que, num crash exatamente
entre o use case retornar e o Inbox ser gravado, uma redelivery reprocessaria
a mensagem — mas isso é seguro por design: a fonte da verdade de idempotência
é a constraint `UNIQUE(provider_id, idempotency_key)` no nível de negócio
(seção 4), não o Inbox. O Inbox aqui é uma otimização de custo (evita chamar
o use case inteiro de novo para uma mensagem obviamente repetida), não a
garantia final — então essa janela não compromete a correção, só a
eficiência marginal em um cenário raro.

**DLQ**: a política de `maxReceiveCount` que decide quando uma mensagem vai
para a DLQ é configurada na fila em si (fora do código da aplicação — seria
parte de um script de provisionamento de infraestrutura, não implementado
neste scaffold). O consumer não decide "envie isso pra DLQ agora"
explicitamente; ele só decide "faço ack (termina aqui)" ou "não faço ack
(deixa o SQS decidir o que fazer com a redelivery)".

**Limitação conhecida**: não escrevi um teste de integração automatizado
para o `SqsConsumer` (só validei manualmente publicando mensagens via
`awslocal`, ver README.md) — está na lista de próximos passos.

## 7. Escolha de ORM

O desafio recomenda MikroORM como preferencial. Optei por acessar o Postgres
diretamente via `pg` (node-postgres) na camada de infraestrutura porque a
operação mais crítica do sistema — o `UPDATE` otimista da wallet com
`WHERE version = ?` e a checagem explícita de linhas afetadas — fica mais
direta de escrever, ler e auditar em SQL puro do que atrás do
`EntityManager.transactional()` e `LockMode` de um ORM.

Os repositórios implementam as mesmas portas (`WalletRepository`,
`WagerTransactionRepository`, etc.) que o caso de uso depende — então trocar
essa implementação por MikroORM (usando `EntityManager.transactional()` como
`UnitOfWork` e `LockMode.OPTIMISTIC` nos `em.findOne`) é uma troca mecânica
na camada de infraestrutura, sem tocar em domínio ou casos de uso. Se a banca
preferir ver a versão com MikroORM, esse é o próximo passo natural.

## 8. Testes

**Implementado neste scaffold:**
- Testes de unidade completos para `Money` (escala, arredondamento, entradas
  inválidas, ausência de drift de float) e `Wallet` (todas as invariantes de
  saldo, incluindo o cenário obrigatório da seção 8, testado
  single-threaded). Ver `test/unit/`.
- Testes de unidade para as transições de estado de `WagerTransaction`.
- **Testes de concorrência com paralelismo real**, rodando contra Postgres
  de verdade via `docker-compose` (não mocks): o cenário obrigatório da
  seção 8 (duas apostas de 80.00 contra saldo de 100.00 → uma `PROCESSED`,
  uma `REJECTED`, saldo final 20.00, um único lançamento de débito), a mesma
  aposta enviada 50 vezes em paralelo (idempotência sob concorrência real,
  incluindo a corrida de `unique_violation` descrita na seção 4), wallets
  distintas processando em paralelo sem bloqueio cruzado, e três instâncias
  simultâneas disputando a mesma wallet. Ver `test/concurrency/`.

**Não implementado neste scaffold (roadmap):**
- Testes de integração dedicados fora do que já é exercitado pelos testes
  de concorrência (ex.: migrations e constraints isoladamente, atomicidade
  entre inbox/outbox/ledger fora do caminho principal, recuperação após
  reinicialização simulada, publishers concorrentes da outbox).
- Teste de carga.

Isso é uma limitação real e reconhecida, não um item totalmente resolvido:
os testes de concorrência cobrem a garantia mais crítica do desafio (seção
3 deste documento), mas os testes de integração mais amplos da seção 13
(migrations, DLQ, redelivery, crash recovery) ainda não foram escritos —
prioridade descrita na seção 10.

## 9. Autenticação

Não implementada. Seguindo a opção explícita do desafio de documentar a
decisão em vez de implementar: o ponto de extensão seria um `AuthGuard`
no-op no NestJS, substituível por um guard real de validação de JWT emitido
por um IdP (Keycloak/Zitadel) via OIDC, sem tabela própria de usuários.

## 10. Limitações conhecidas (resumo para a apresentação)

1. Teste de integração automatizado para o `SqsConsumer` não escrito (só
   validado manualmente via `awslocal`, ver README.md).
2. Provisionamento das filas SQS no LocalStack é manual (comando `awslocal`
   documentado no README), não automatizado no `docker-compose.yml`.
3. Testes de integração mais amplos (migrations isoladamente, DLQ real após
   `maxReceiveCount`, publishers concorrentes da outbox) não escritos.
4. Endpoint de reconciliação — ✅ implementado
   (`POST /wallets/:walletId/reconciliation`), compara saldo materializado
   vs. recalculado do ledger e reporta divergência sem corrigir
   silenciosamente.
5. Contador de tentativas de `PENDING_REFERENCE` não persistido — o
   `PendingReferenceWorker` tem o ponto de extensão marcado com `TODO`.
6. Observabilidade: logs estruturados e métricas não implementados (o
   `SqsConsumer`, os use cases e o endpoint de reconciliação usam
   `console.error`/`console.log` simples).

Decidi ser transparente sobre esses pontos em vez de simular uma
implementação completa que não foi de fato testada — o desafio deixa claro
que "não esperamos perfeição, esperamos raciocínio claro e decisões
justificadas".
