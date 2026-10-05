import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedContent } from "./content.js";
import { connect, ensureDatabase, migrate } from "./db.js";

const config = loadConfig();

// Databasen kan være pauset (gratis Azure SQL) – serveren starter likevel med en gang,
// og API-kall venter til tilkobling, migrering og innhold er klart.
const ready = (async () => {
  if (config.autoCreateDatabase) await ensureDatabase(config.databaseUrl);
  const db = await connect(config.databaseUrl);
  const ran = await migrate(db, config.migrationsDir);
  if (ran.length) console.log(`Migreringer kjørt: ${ran.join(", ")}`);
  const seeded = await seedContent(db, config.contentDir);
  console.log(`Innhold: ${seeded.sets} sett og ${seeded.tasks} oppgaver lastet inn, ${seeded.skipped} kilder uendret`);
  return db;
})();
ready.catch((err) => {
  console.error("Klarte ikke å klargjøre databasen:", err);
  process.exit(1);
});

const server = serve({ fetch: createApp(ready, config).fetch, port: config.port }, (info) => {
  console.log(`Mattekamp kjører på http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void ready.then((db) => db.close()).catch(() => {}).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
