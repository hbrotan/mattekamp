import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

export interface Config {
  port: number;
  /** SQL Server-tilkoblingsstreng, f.eks. "Server=tcp:x.database.windows.net,1433;Database=...;User Id=...;Password=...;Encrypt=true" */
  databaseUrl: string;
  /** Lag databasen hvis den mangler (lokalt og i tester) */
  autoCreateDatabase: boolean;
  /** Sett Secure-flagget på innloggings-cookien (påkrevd bak HTTPS i produksjon). */
  secureCookies: boolean;
  webDir: string;
  contentDir: string;
  migrationsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL mangler");
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl,
    autoCreateDatabase: env.DB_AUTO_CREATE === "true",
    secureCookies: (env.SECURE_COOKIES ?? (env.NODE_ENV === "production" ? "true" : "false")) === "true",
    webDir: path.resolve(env.WEB_DIR ?? path.join(root, "web")),
    contentDir: path.resolve(env.CONTENT_DIR ?? path.join(root, "content")),
    migrationsDir: path.resolve(env.MIGRATIONS_DIR ?? path.join(root, "migrations")),
  };
}
