// Direct DB access for tests — set balances, simulate geo's worker finishing.
import postgres from "postgres";
import { E2E } from "./global-setup";

async function withDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(E2E.dbUrl, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export const setBalance = (credits: number) =>
  withDb((sql) => sql`UPDATE teams SET credit_balance = ${credits} WHERE id = ${E2E.teamId}`);

export const getBalance = () =>
  withDb(async (sql) => {
    const [row] = await sql`SELECT credit_balance FROM teams WHERE id = ${E2E.teamId}`;
    return row.credit_balance as number;
  });

