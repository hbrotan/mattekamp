import fs from "node:fs/promises";
import path from "node:path";
import mssql from "mssql";

/**
 * Tynt lag over Azure SQL / SQL Server. Spørringer skrives som tagged templates:
 *   await db.query<Row>`select * from players where id = ${id}`
 * Verdiene blir parametre (@p0, @p1 ...), og kolonnenavn kommer ut i camelCase.
 */
export type Query = <T = Record<string, any>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export interface Db {
  query: Query;
  /** Kjører fn i én transaksjon; ruller tilbake ved feil. */
  tx<R>(fn: (query: Query) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** Rå SQL-bit som settes rett inn (aldri brukerdata!), f.eks. en felles ORDER BY. */
export class RawSql { constructor(readonly text: string) {} }
export const raw = (text: string) => new RawSql(text);

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

function bind(request: mssql.Request, strings: TemplateStringsArray, values: unknown[]): string {
  let text = strings[0] ?? "";
  values.forEach((v, i) => {
    if (v instanceof RawSql) { text += v.text + (strings[i + 1] ?? ""); return; }
    const name = `p${i}`;
    if (v === null || v === undefined) request.input(name, mssql.NVarChar, null);
    else if (typeof v === "string") request.input(name, v.length > 4000 ? mssql.NVarChar(mssql.MAX) : mssql.NVarChar(4000), v);
    else if (typeof v === "number") request.input(name, Number.isInteger(v) ? mssql.Int : mssql.Float, v);
    else if (typeof v === "boolean") request.input(name, mssql.Bit, v);
    else if (v instanceof Date) request.input(name, mssql.DateTime2, v);
    else throw new Error(`Ukjent parametertype: ${typeof v}`);
    text += `@${name}` + (strings[i + 1] ?? "");
  });
  return text;
}

async function run<T>(request: mssql.Request, strings: TemplateStringsArray, values: unknown[]): Promise<T[]> {
  const result = await request.query(bind(request, strings, values));
  // Siste resultatsett: lar én batch gjøre insert/update og så select
  const rows = (result.recordsets as unknown as Record<string, unknown>[][]).at(-1) ?? [];
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]))) as T[];
}

// Feil som betyr at databasen våkner fra pause, er utilgjengelig et øyeblikk, el.l.
const TRANSIENT = new Set([40613, 40197, 40501, 40540, 49918, 49919, 49920, 4060, 4221, 10928, 10929, 10053, 10054, 10060, 233, 64]);
function isTransient(err: unknown): boolean {
  const e = err as { number?: number; code?: string; originalError?: { number?: number; code?: string } };
  const num = e?.number ?? e?.originalError?.number;
  const code = e?.code ?? e?.originalError?.code;
  return (num !== undefined && TRANSIENT.has(num)) || ["ESOCKET", "ETIMEOUT", "ECONNCLOSED", "ECONNRESET"].includes(code ?? "");
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  // Gratisdatabasen pauser ved inaktivitet og bruker opptil ca. ett minutt på å våkne
  const deadline = Date.now() + 120_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || Date.now() > deadline) throw err;
      const wait = Math.min(1000 * attempt, 5000);
      console.warn(`${label}: databasen svarer ikke ennå (${(err as Error).message}), prøver igjen om ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function connect(connectionString: string): Promise<Db> {
  const config = mssql.ConnectionPool.parseConnectionString(connectionString);
  config.pool = { max: 10, min: 0, idleTimeoutMillis: 30_000 }; // lukk ubrukte tilkoblinger så databasen kan pause
  config.connectionTimeout = 30_000;
  config.requestTimeout = 30_000;
  config.options = { ...config.options, enableArithAbort: true };
  const pool = new mssql.ConnectionPool(config);
  pool.on("error", (err) => console.error("Databasefeil:", err));
  await withRetry(() => pool.connect(), "Tilkobling");

  return {
    query: (strings, ...values) => withRetry(() => run(pool.request(), strings, values), "Spørring"),
    async tx(fn) {
      return withRetry(async () => {
        const transaction = new mssql.Transaction(pool);
        await transaction.begin();
        try {
          const result = await fn((strings, ...values) => run(new mssql.Request(transaction), strings, values));
          await transaction.commit();
          return result;
        } catch (err) {
          await transaction.rollback().catch(() => {});
          throw err;
        }
      }, "Transaksjon");
    },
    close: () => pool.close(),
  };
}

/** Lager databasen hvis den mangler (lokalt/test; i Azure lages den av Bicep). */
export async function ensureDatabase(connectionString: string): Promise<void> {
  const config = mssql.ConnectionPool.parseConnectionString(connectionString);
  const name = config.database;
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Ugyldig databasenavn");
  const pool = await withRetry(() => new mssql.ConnectionPool({ ...config, database: "master" }).connect(), "Tilkobling");
  try {
    await pool.request().query(`if db_id('${name}') is null create database [${name}]`);
  } finally {
    await pool.close();
  }
}

/**
 * Kjører SQL-filene i migrations/ som ikke er kjørt før, i navnerekkefølge, i én transaksjon.
 * Filene deles opp på linjer med bare «GO». En applikasjonslås hindrer at to instanser migrerer samtidig.
 */
export async function migrate(db: Db, migrationsDir: string): Promise<string[]> {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const scripts = await Promise.all(files.map(async (f) => [f, await fs.readFile(path.join(migrationsDir, f), "utf8")] as const));
  return db.tx(async (q) => {
    await q`exec sp_getapplock @Resource = 'mattekamp-migrate', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 60000`;
    await q`if object_id('schema_migrations') is null
            create table schema_migrations (name nvarchar(200) primary key, applied_at datetime2 not null default sysutcdatetime())`;
    const applied = new Set((await q<{ name: string }>`select name from schema_migrations`).map((r) => r.name));
    const ran: string[] = [];
    for (const [file, body] of scripts) {
      if (applied.has(file)) continue;
      for (const batch of body.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter(Boolean)) {
        await q([batch] as unknown as TemplateStringsArray);
      }
      await q`insert into schema_migrations (name) values (${file})`;
      ran.push(file);
    }
    return ran;
  });
}
