import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { Db } from "./db.js";

export const SESSION_COOKIE = "mh_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // ett år – barn skal slippe å logge inn på nytt

export interface Player {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  groupCode: string;
}

export type AppEnv = { Variables: { player: Player } };

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Uten tegn som er lette å forveksle (0/O, 1/I/L)
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newGroupCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export async function startSession(c: Context, db: Db, playerId: string, secure: boolean): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.query`insert into sessions (token_hash, player_id) values (${hashToken(token)}, ${playerId})`;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function endSession(c: Context, db: Db): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.query`delete from sessions where token_hash = ${hashToken(token)}`;
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function requireAuth(getDb: () => Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const db = getDb();
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) throw new HTTPException(401, { message: "Ikke innlogget" });
    const [row] = await db.query<Player & { stale: number }>`
      select p.id, p.name, g.id as group_id, g.name as group_name, g.code as group_code,
             case when s.last_seen_at < dateadd(hour, -1, sysutcdatetime()) then 1 else 0 end as stale
      from sessions s
      join players p on p.id = s.player_id
      join groups g on g.id = p.group_id
      where s.token_hash = ${hashToken(token)}`;
    if (!row) throw new HTTPException(401, { message: "Ikke innlogget" });
    if (row.stale) await db.query`update sessions set last_seen_at = sysutcdatetime() where token_hash = ${hashToken(token)}`;
    const { stale: _stale, ...player } = row;
    c.set("player", player);
    await next();
  };
}

/** Enkel minnebasert begrensning per IP for innlogging og gruppeopprettelse. */
export function rateLimit(limit: number, windowMs: number, keyOf: (c: Context) => string): MiddlewareHandler {
  const hits = new Map<string, number[]>();
  return async (c, next) => {
    const key = keyOf(c);
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) throw new HTTPException(429, { message: "For mange forsøk. Vent litt og prøv igjen." });
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    await next();
  };
}
