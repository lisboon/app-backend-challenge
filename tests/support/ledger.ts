import type { MikroORM } from '@mikro-orm/postgresql';

export async function debitWallet(
  orm: MikroORM,
  walletId: string,
  amount = '1.00',
): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    const [wallet] = await em.execute<
      {
        player_id: string;
        currency: string;
        balance: string;
        version: number;
      }[]
    >(
      'select player_id,currency,balance::text,version from wallets where id = ? for update',
      [walletId],
    );
    const id = Bun.randomUUIDv7();
    await em.execute(
      "insert into wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,currency,round_id,game_id,kind,amount,status,result_balance,result_currency,created_at,processed_at) values (?,'provider-test',?,?,?, ?,?,?, 'round-test','game-test','BET',?,'PROCESSED',?::numeric - ?::numeric,?,now(),now())",
      [
        id,
        id,
        id,
        'v1:' + 'a'.repeat(64),
        walletId,
        wallet.player_id,
        wallet.currency,
        amount,
        wallet.balance,
        amount,
        wallet.currency,
      ],
    );
    await em.execute(
      "insert into wallet_ledger_entries (id,wallet_id,transaction_id,direction,amount,balance_before,balance_after,wallet_version,created_at) values (?,?,?,'DEBIT',?::numeric,?::numeric,?::numeric - ?::numeric,?,now())",
      [
        Bun.randomUUIDv7(),
        walletId,
        id,
        amount,
        wallet.balance,
        wallet.balance,
        amount,
        wallet.version + 1,
      ],
    );
    await em.execute(
      'update wallets set balance=balance - ?::numeric,version=version+1,updated_at=now() where id=?',
      [amount, walletId],
    );
  });
}
