import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql;

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    // Kolonner kommer ut i camelCase (group_id -> groupId)
    transform: { ...postgres.camel, undefined: null },
  });
}

/** Kjører SQL-filene i migrations/ som ikke er kjørt før, i navnerekkefølge. */
export async function migrate(sql: Sql, migrationsDir: string): Promise<string[]> {
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  // Låsen hindrer at flere instanser som starter samtidig migrerer om hverandre
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(4711)`;
    await conn`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await conn<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await conn.unsafe(`begin;\n${body}\n;insert into schema_migrations (name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
      ran.push(file);
    }
    return ran;
  } catch (err) {
    await conn`rollback`.catch(() => {});
    throw err;
  } finally {
    await conn`select pg_advisory_unlock(4711)`.catch(() => {});
    conn.release();
  }
}
