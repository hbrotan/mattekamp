import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { endSession, newGroupCode, rateLimit, requireAuth, startSession, type AppEnv, type Player } from "./auth.js";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { isCorrect, normalizeAnswer } from "./grading.js";

z.config(z.locales.no());

const Name = z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1, "Navn mangler").max(30, "Navnet er for langt"));
const GroupName = z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(1, "Gruppenavn mangler").max(40, "Gruppenavnet er for langt"));
const Elapsed = z.number().int().min(0).max(60 * 60 * 24).optional();

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  // Krever JSON: hindrer at vanlige HTML-skjema fra andre sider kan sende inn data (CSRF)
  if (!c.req.header("content-type")?.includes("application/json")) {
    throw new HTTPException(415, { message: "Forventet JSON" });
  }
  let data: unknown;
  try { data = await c.req.json(); } catch { throw new HTTPException(400, { message: "Ugyldig JSON" }); }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Ugyldige data" });
  return parsed.data;
}

const notFound = (what = "Fant ikke det du lette etter") => new HTTPException(404, { message: what });

interface TaskRow {
  id: string;
  n: number;
  kind: string;
  points: number;
  prompt: { images: string[] };
  options: string[] | null;
  answer: string;
  solution: { images: string[] } | null;
}

interface AttemptRow {
  id: string;
  playerId: string;
  setId: string;
  title: string;
  mode: "practice" | "contest";
  startedAt: Date;
  finishedAt: Date | null;
  elapsedSeconds: number;
  points: number;
  maxPoints: number;
  correct: number;
  total: number;
}

const assetUrl = (p: string) => `/assets/${p}`;

export function createApp(sql: Sql, config: Config) {
  const app = new Hono<AppEnv>();
  const auth = requireAuth(sql);
  const clientIp = (c: Context) => {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    try { return getConnInfo(c).remote.address ?? "ukjent"; } catch { return "ukjent"; }
  };
  const loginLimit = rateLimit(30, 10 * 60_000, clientIp);

  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Noe gikk galt på serveren" }, 500);
  });

  // ---------- Helse ----------
  app.get("/api/health", async (c) => {
    await sql`select 1`;
    return c.json({ ok: true });
  });

  // ---------- Grupper og innlogging ----------
  const sessionView = (p: Player) => ({ player: { id: p.id, name: p.name }, group: { name: p.groupName, code: p.groupCode } });

  app.post("/api/groups", loginLimit, async (c) => {
    const input = await body(c, z.object({ groupName: GroupName, playerName: Name }));
    const created = await sql.begin(async (tx) => {
      let group: { id: string; code: string } | undefined;
      for (let i = 0; i < 5 && !group; i++) {
        [group] = await tx<{ id: string; code: string }[]>`
          insert into groups (name, code) values (${input.groupName}, ${newGroupCode()})
          on conflict (code) do nothing returning id, code`;
      }
      if (!group) throw new Error("Klarte ikke å lage unik gruppekode");
      const [player] = await tx<{ id: string; name: string }[]>`
        insert into players (group_id, name) values (${group.id}, ${input.playerName}) returning id, name`;
      return { group, player: player! };
    });
    await startSession(c, sql, created.player.id, config.secureCookies);
    return c.json(sessionView({
      id: created.player.id, name: created.player.name,
      groupId: created.group.id, groupName: input.groupName, groupCode: created.group.code,
    }), 201);
  });

  app.post("/api/session", loginLimit, async (c) => {
    const input = await body(c, z.object({ code: z.string().trim().toUpperCase(), name: Name }));
    const [group] = await sql<{ id: string; name: string; code: string }[]>`
      select id, name, code from groups where code = ${input.code}`;
    if (!group) throw notFound("Fant ingen gruppe med den koden");
    // Samme navn i samme gruppe = samme spiller (slik at man kan fortsette på en ny enhet)
    const [player] = await sql<{ id: string; name: string }[]>`
      insert into players (group_id, name) values (${group.id}, ${input.name})
      on conflict (group_id, lower(name)) do update set name = players.name
      returning id, name`;
    await startSession(c, sql, player!.id, config.secureCookies);
    return c.json(sessionView({ id: player!.id, name: player!.name, groupId: group.id, groupName: group.name, groupCode: group.code }));
  });

  app.get("/api/session", auth, (c) => c.json(sessionView(c.get("player"))));

  app.delete("/api/session", async (c) => {
    await endSession(c, sql);
    return c.json({ ok: true });
  });

  app.get("/api/group/players", auth, async (c) => {
    const rows = await sql<{ name: string }[]>`
      select name from players where group_id = ${c.get("player").groupId} order by lower(name)`;
    return c.json(rows.map((r) => r.name));
  });

  // ---------- Oppgavesett ----------
  app.get("/api/sets", auth, async (c) => {
    const me = c.get("player");
    const rows = await sql`
      select s.id, s.source, s.title, s.level, s.level_name, s.grades, s.year,
             count(t.id)::int as task_count, sum(t.points)::int as max_points,
             (select max(a.points) from attempts a
               where a.set_id = s.id and a.player_id = ${me.id} and a.finished_at is not null)::int as my_best
      from task_sets s
      join tasks t on t.set_id = s.id
      where s.active
      group by s.id
      order by s.source, s.year desc nulls last, s.sort_key`;
    return c.json(rows);
  });

  // ---------- Forsøk ----------
  async function loadAttempt(id: string, playerId: string): Promise<AttemptRow> {
    if (!z.uuid().safeParse(id).success) throw notFound();
    const [row] = await sql<AttemptRow[]>`
      select a.*, s.title from attempts a join task_sets s on s.id = a.set_id
      where a.id = ${id} and a.player_id = ${playerId}`;
    if (!row) throw notFound();
    return row;
  }

  async function attemptView(a: AttemptRow) {
    const tasks = await sql<TaskRow[]>`select * from tasks where set_id = ${a.setId} order by n`;
    const answers = new Map(
      (await sql<{ taskId: string; answer: string; isCorrect: boolean }[]>`
        select task_id, answer, is_correct from attempt_answers where attempt_id = ${a.id}`).map((r) => [r.taskId, r]),
    );
    const finished = a.finishedAt !== null;
    const showScore = finished || a.mode === "practice";
    let points = 0, correct = 0;
    const taskViews = tasks.map((t) => {
      const mine = answers.get(t.id);
      if (mine?.isCorrect) { points += t.points; correct++; }
      return taskView(t, mine, finished || (a.mode === "practice" && !!mine));
    });
    return {
      id: a.id,
      setId: a.setId,
      title: a.title,
      mode: a.mode,
      finished,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      elapsedSeconds: a.elapsedSeconds,
      answered: answers.size,
      total: tasks.length,
      maxPoints: tasks.reduce((s, t) => s + t.points, 0),
      points: showScore ? points : null,
      correct: showScore ? correct : null,
      tasks: taskViews,
    };
  }

  function taskView(t: TaskRow, mine: { answer: string; isCorrect: boolean } | undefined, reveal: boolean) {
    return {
      n: t.n,
      kind: t.kind,
      points: t.points,
      options: t.options,
      images: t.prompt.images.map(assetUrl),
      answer: mine?.answer ?? null,
      ...(reveal ? {
        isCorrect: mine ? mine.isCorrect : false,
        correctAnswer: t.answer,
        solution: (t.solution?.images ?? []).map(assetUrl),
      } : {}),
    };
  }

  const clampElapsed = (a: AttemptRow, reported: number | undefined) => {
    const wall = Math.floor((Date.now() - new Date(a.startedAt).getTime()) / 1000);
    return Math.max(a.elapsedSeconds, Math.min(reported ?? a.elapsedSeconds, wall));
  };

  app.post("/api/attempts", auth, async (c) => {
    const me = c.get("player");
    const input = await body(c, z.object({ setId: z.string(), mode: z.enum(["practice", "contest"]) }));
    const [stats] = await sql<{ total: number; maxPoints: number }[]>`
      select count(*)::int as total, coalesce(sum(points), 0)::int as max_points
      from tasks t join task_sets s on s.id = t.set_id where s.id = ${input.setId} and s.active`;
    if (!stats?.total) throw notFound("Fant ikke oppgavesettet");
    const [created] = await sql<{ id: string }[]>`
      insert into attempts (player_id, set_id, mode, max_points, total)
      values (${me.id}, ${input.setId}, ${input.mode}, ${stats.maxPoints}, ${stats.total}) returning id`;
    return c.json(await attemptView(await loadAttempt(created!.id, me.id)), 201);
  });

  app.get("/api/attempts/active", auth, async (c) => {
    const rows = await sql`
      select a.id, a.set_id, s.title, a.mode, a.started_at, a.total,
             (select count(*)::int from attempt_answers x where x.attempt_id = a.id) as answered
      from attempts a join task_sets s on s.id = a.set_id
      where a.player_id = ${c.get("player").id} and a.finished_at is null
      order by a.started_at desc`;
    return c.json(rows);
  });

  app.get("/api/attempts/history", auth, async (c) => {
    const rows = await sql`
      select a.id, a.set_id, s.title, a.mode, a.points, a.max_points, a.correct, a.total,
             a.elapsed_seconds, a.finished_at
      from attempts a join task_sets s on s.id = a.set_id
      where a.player_id = ${c.get("player").id} and a.finished_at is not null
      order by a.finished_at desc
      limit 200`;
    return c.json(rows);
  });

  app.get("/api/attempts/:id", auth, async (c) => {
    return c.json(await attemptView(await loadAttempt(c.req.param("id"), c.get("player").id)));
  });

  app.delete("/api/attempts/:id", auth, async (c) => {
    const a = await loadAttempt(c.req.param("id"), c.get("player").id);
    if (a.finishedAt) throw new HTTPException(409, { message: "Forsøket er allerede levert" });
    await sql`delete from attempts where id = ${a.id}`;
    return c.json({ ok: true });
  });

  app.put("/api/attempts/:id/answers/:n", auth, async (c) => {
    const me = c.get("player");
    const a = await loadAttempt(c.req.param("id"), me.id);
    if (a.finishedAt) throw new HTTPException(409, { message: "Forsøket er allerede levert" });
    const n = Number(c.req.param("n"));
    const input = await body(c, z.object({ answer: z.string().max(50).nullable(), elapsedSeconds: Elapsed }));
    const [task] = await sql<TaskRow[]>`select * from tasks where set_id = ${a.setId} and n = ${n}`;
    if (!task) throw notFound("Fant ikke oppgaven");
    const elapsed = clampElapsed(a, input.elapsedSeconds);

    if (input.answer === null) {
      if (a.mode === "practice") throw new HTTPException(409, { message: "Svar i øvingsmodus kan ikke angres" });
      await sql`delete from attempt_answers where attempt_id = ${a.id} and task_id = ${task.id}`;
    } else {
      const answer = normalizeAnswer(task, input.answer);
      if (answer === null) throw new HTTPException(400, { message: "Ugyldig svar" });
      const ok = isCorrect(task, answer);
      if (a.mode === "practice") {
        const inserted = await sql`
          insert into attempt_answers (attempt_id, task_id, answer, is_correct, points)
          values (${a.id}, ${task.id}, ${answer}, ${ok}, ${ok ? task.points : 0})
          on conflict do nothing returning task_id`;
        if (!inserted.length) throw new HTTPException(409, { message: "Oppgaven er allerede besvart" });
      } else {
        await sql`
          insert into attempt_answers (attempt_id, task_id, answer, is_correct, points)
          values (${a.id}, ${task.id}, ${answer}, ${ok}, ${ok ? task.points : 0})
          on conflict (attempt_id, task_id) do update set
            answer = excluded.answer, is_correct = excluded.is_correct, points = excluded.points, answered_at = now()`;
      }
    }
    await sql`update attempts set elapsed_seconds = ${elapsed} where id = ${a.id}`;
    const view = await attemptView({ ...a, elapsedSeconds: elapsed });
    return c.json({
      task: view.tasks.find((t) => t.n === n),
      answered: view.answered,
      points: view.points,
      correct: view.correct,
    });
  });

  app.post("/api/attempts/:id/finish", auth, async (c) => {
    const me = c.get("player");
    const a = await loadAttempt(c.req.param("id"), me.id);
    if (a.finishedAt) throw new HTTPException(409, { message: "Forsøket er allerede levert" });
    const input = await body(c, z.object({ elapsedSeconds: Elapsed }));
    const elapsed = clampElapsed(a, input.elapsedSeconds);
    const [done] = await sql<AttemptRow[]>`
      update attempts set
        finished_at = now(),
        elapsed_seconds = ${elapsed},
        points = coalesce((select sum(points) from attempt_answers where attempt_id = ${a.id}), 0),
        correct = (select count(*) from attempt_answers where attempt_id = ${a.id} and is_correct)
      where id = ${a.id} and finished_at is null
      returning *`;
    if (!done) throw new HTTPException(409, { message: "Forsøket er allerede levert" });
    const [better] = await sql<{ count: number }[]>`
      with best as (
        select distinct on (x.player_id) x.player_id, x.points, x.elapsed_seconds
        from attempts x join players p on p.id = x.player_id
        where p.group_id = ${me.groupId} and x.set_id = ${a.setId} and x.finished_at is not null
          and x.player_id <> ${me.id}
        order by x.player_id, x.points desc, x.elapsed_seconds asc, x.finished_at asc
      )
      select count(*)::int as count from best
      where points > ${done.points} or (points = ${done.points} and elapsed_seconds < ${done.elapsedSeconds})`;
    const view = await attemptView({ ...done, title: a.title });
    return c.json({ ...view, rank: (better?.count ?? 0) + 1 });
  });

  // ---------- Toppliste (innenfor egen gruppe) ----------
  app.get("/api/leaderboard", auth, async (c) => {
    const me = c.get("player");
    const setId = c.req.query("set");
    const sets = await sql`
      select distinct s.id, s.title, s.level, s.year
      from attempts a join players p on p.id = a.player_id join task_sets s on s.id = a.set_id
      where p.group_id = ${me.groupId} and a.finished_at is not null
      order by s.level, s.year desc`;

    if (setId) {
      const rows = await sql`
        select * from (
          select distinct on (a.player_id) a.player_id, p.name, a.mode, a.points, a.max_points, a.correct,
                 a.total, a.elapsed_seconds, a.finished_at
          from attempts a join players p on p.id = a.player_id
          where p.group_id = ${me.groupId} and a.set_id = ${setId} and a.finished_at is not null
          order by a.player_id, a.points desc, a.elapsed_seconds asc, a.finished_at asc
        ) best
        order by points desc, elapsed_seconds asc, finished_at asc`;
      return c.json({ sets, setId, rows });
    }

    const rows = await sql`
      with best as (
        select distinct on (a.player_id, a.set_id) a.player_id, a.set_id, a.points, a.correct, a.total
        from attempts a join players p on p.id = a.player_id
        where p.group_id = ${me.groupId} and a.finished_at is not null
        order by a.player_id, a.set_id, a.points desc, a.elapsed_seconds asc
      )
      select b.player_id, p.name, sum(b.points)::int as points, count(*)::int as sets,
             sum(b.correct)::int as correct, sum(b.total)::int as tasks
      from best b join players p on p.id = b.player_id
      group by b.player_id, p.name
      order by points desc, sets desc, p.name`;
    return c.json({ sets, setId: null, rows });
  });

  app.all("/api/*", () => { throw notFound("Ukjent API-adresse"); });

  // ---------- Bilder (bare for innloggede) og nettsiden ----------
  // Bare bildefiler – sets.json o.l. inneholder fasiten og skal aldri ut
  const ASSET_PATH = /^\/assets\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\.(png|jpe?g|webp|svg)$/i;
  app.use("/assets/*", auth, async (c, next) => {
    if (!ASSET_PATH.test(c.req.path)) throw notFound();
    await next();
  });
  app.use("/assets/*", serveStatic({
    root: config.contentDir,
    rewriteRequestPath: (p) => p.replace(/^\/assets/, ""),
    onFound: (_p, c) => { c.header("Cache-Control", "private, max-age=86400"); },
  }));
  app.use("/*", serveStatic({ root: config.webDir }));

  return app;
}
