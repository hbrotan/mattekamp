import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { seedContent } from "./content.js";
import { connect, migrate } from "./db.js";

const config = loadConfig();
const sql = connect(config.databaseUrl);

const ran = await migrate(sql, config.migrationsDir);
if (ran.length) console.log(`Migreringer kjørt: ${ran.join(", ")}`);
const seeded = await seedContent(sql, config.contentDir);
console.log(`Innhold: ${seeded.sets} sett og ${seeded.tasks} oppgaver lastet inn, ${seeded.skipped} kilder uendret`);

const server = serve({ fetch: createApp(sql, config).fetch, port: config.port }, (info) => {
  console.log(`Mattekamp kjører på http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void sql.end({ timeout: 5 }).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
