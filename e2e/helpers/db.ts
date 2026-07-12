// Direct DB access for tests — set balances, simulate geo's worker finishing.
// Every helper takes the team id explicitly so parallel spec files (each with
// its own seeded team) can't reach into each other's state by default.
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

export const setBalance = (credits: number, teamId: string = E2E.teamId) =>
  withDb((sql) => sql`UPDATE teams SET credit_balance = ${credits} WHERE id = ${teamId}`);

export const getBalance = (teamId: string = E2E.teamId) =>
  withDb(async (sql) => {
    const [row] = await sql`SELECT credit_balance FROM teams WHERE id = ${teamId}`;
    return row.credit_balance as number;
  });
