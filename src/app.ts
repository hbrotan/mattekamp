import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { endSession, newGroupCode, rateLimit, requireAuth, startSession, type AppEnv, type Player } from "./auth.js";
import type { Config } from "./config.js";
import { raw, type Db } from "./db.js";
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
const conflict = (what: string) => new HTTPException(409, { message: what });

// SQL Server gir uniqueidentifier med store bokstaver; vi bruker små utad
const id = (v: string) => v.toLowerCase();

interface TaskRow {
  id: string;
  n: number;
  kind: string;
  points: number;
  prompt: string;
  options: string | null;
  answer: string;
  solution: string | null;
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

// Beste forsøk per spiller: flest poeng, så kortest tid, så først levert
const BEST_ORDER = "a.points desc, a.elapsed_seconds asc, a.finished_at asc";

/**
 * @param ready løses når databasen er tilkoblet, migrert og har innhold. Serveren kan
 *   dermed starte og svare på helsesjekk før en pauset gratisdatabase har våknet.
 */
export function createApp(ready: Promise<Db>, config: Config) {
  const app = new Hono<AppEnv>();
  let db!: Db;
  const whenReady = ready.then((d) => { db = d; });
  whenReady.catch(() => {});
  const waitForDb: MiddlewareHandler = async (_c, next) => { await whenReady; await next(); };
  const auth = requireAuth(() => db);

  const clientIp = (c: Context) => {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    try { return getConnInfo(c).remote.address ?? "ukjent"; } catch { return "ukjent"; }
  };
  const loginLimit = rateLimit(30, 10 * 60_000, clientIp);

  // YouTube-innbygging krever at nettleseren sender opphavet (Referer) – «no-referrer» gir feil 153
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", referrerPolicy: "strict-origin-when-cross-origin" }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Noe gikk galt på serveren" }, 500);
  });

  // ---------- Helse (uten database, så containeren regnes som oppe mens databasen våkner) ----------
  app.get("/api/health", async (c) => {
    if (c.req.query("deep") !== undefined) {
      await whenReady;
      await db.query`select 1 as ok`;
    }
    return c.json({ ok: true });
  });

  app.use("/api/*", waitForDb);
  app.use("/assets/*", waitForDb);

  // ---------- Grupper og innlogging ----------
  const sessionView = (p: Player) => ({ player: { id: id(p.id), name: p.name }, group: { name: p.groupName, code: p.groupCode } });

  app.post("/api/groups", loginLimit, async (c) => {
    const input = await body(c, z.object({ groupName: GroupName, playerName: Name }));
    const created = await db.tx(async (q) => {
      let group: { id: string; code: string } | undefined;
      for (let i = 0; i < 5 && !group; i++) {
        const code = newGroupCode();
        [group] = await q<{ id: string; code: string }>`
          insert into groups (name, code)
          output inserted.id, inserted.code
          select ${input.groupName}, ${code}
          where not exists (select 1 from groups with (updlock, holdlock) where code = ${code})`;
      }
      if (!group) throw new Error("Klarte ikke å lage unik gruppekode");
      const [player] = await q<{ id: string; name: string }>`
        insert into players (group_id, name) output inserted.id, inserted.name values (${group.id}, ${input.playerName})`;
      return { group, player: player! };
    });
    await startSession(c, db, created.player.id, config.secureCookies);
    return c.json(sessionView({
      id: created.player.id, name: created.player.name,
      groupId: created.group.id, groupName: input.groupName, groupCode: created.group.code,
    }), 201);
  });

  app.post("/api/session", loginLimit, async (c) => {
    const input = await body(c, z.object({ code: z.string().trim().toUpperCase(), name: Name }));
    const [group] = await db.query<{ id: string; name: string; code: string }>`
      select id, name, code from groups where code = ${input.code}`;
    if (!group) throw notFound("Fant ingen gruppe med den koden");
    // Samme navn i samme gruppe = samme spiller (slik at man kan fortsette på en ny enhet)
    const [player] = await db.tx((q) => q<{ id: string; name: string }>`
      insert into players (group_id, name)
      select ${group.id}, ${input.name}
      where not exists (select 1 from players with (updlock, holdlock) where group_id = ${group.id} and name = ${input.name});
      select id, name from players where group_id = ${group.id} and name = ${input.name};`);
    await startSession(c, db, player!.id, config.secureCookies);
    return c.json(sessionView({ id: player!.id, name: player!.name, groupId: group.id, groupName: group.name, groupCode: group.code }));
  });

  app.get("/api/session", auth, (c) => c.json(sessionView(c.get("player"))));

  app.delete("/api/session", async (c) => {
    await endSession(c, db);
    return c.json({ ok: true });
  });

  app.get("/api/group/players", auth, async (c) => {
    const rows = await db.query<{ name: string }>`
      select name from players where group_id = ${c.get("player").groupId} order by name`;
    return c.json(rows.map((r) => r.name));
  });

  // ---------- Oppgavesett ----------
  app.get("/api/sets", auth, async (c) => {
    const me = c.get("player");
    const rows = await db.query`
      select s.id, s.source, s.source_name, s.title, s.level, s.level_name, s.grades, s.year,
             count(t.id) as task_count, sum(t.points) as max_points,
             (select max(a.points) from attempts a
               where a.set_id = s.id and a.player_id = ${me.id} and a.finished_at is not null) as my_best
      from task_sets s
      join tasks t on t.set_id = s.id
      where s.active = 1
      group by s.id, s.source, s.source_name, s.title, s.level, s.level_name, s.grades, s.year, s.sort_key
      order by s.source, s.year desc, s.sort_key`;
    return c.json(rows);
  });

  // ---------- Forsøk ----------
  async function loadAttempt(attemptId: string, playerId: string): Promise<AttemptRow> {
    if (!z.uuid().safeParse(attemptId).success) throw notFound();
    const [row] = await db.query<AttemptRow>`
      select a.*, s.title from attempts a join task_sets s on s.id = a.set_id
      where a.id = ${attemptId} and a.player_id = ${playerId}`;
    if (!row) throw notFound();
    return row;
  }

  async function attemptView(a: AttemptRow) {
    const tasks = await db.query<TaskRow>`select * from tasks where set_id = ${a.setId} order by n`;
    const answers = new Map(
      (await db.query<{ taskId: string; answer: string; isCorrect: boolean }>`
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
      id: id(a.id),
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
    const prompt = JSON.parse(t.prompt) as {
      images?: string[]; text?: string; choices?: Record<string, string>; video?: { youtubeId: string; title: string };
      table?: { headers: string[]; rows: string[][]; chart?: "bar"; showTable?: boolean }; unit?: string;
    };
    const solution = t.solution ? (JSON.parse(t.solution) as { images?: string[]; text?: string }) : null;
    return {
      n: t.n,
      kind: t.kind,
      points: t.points,
      options: t.options ? (JSON.parse(t.options) as string[]) : null,
      images: (prompt.images ?? []).map(assetUrl),
      text: prompt.text ?? null,
      choices: prompt.choices ?? null,
      video: prompt.video ?? null,
      table: prompt.table ?? null,
      unit: prompt.unit ?? null,
      answer: mine?.answer ?? null,
      ...(reveal ? {
        isCorrect: mine ? mine.isCorrect : false,
        correctAnswer: t.answer,
        solution: (solution?.images ?? []).map(assetUrl),
        solutionText: solution?.text ?? null,
      } : {}),
    };
  }

  const clampElapsed = (a: AttemptRow, reported: number | undefined) => {
    const wall = Math.floor((Date.now() - new Date(a.startedAt).getTime()) / 1000);
    return Math.max(a.elapsedSeconds, Math.min(reported ?? a.elapsedSeconds, wall));
  };

  app.post("/api/attempts", auth, async (c) => {
    const me = c.get("player");
    const input = await body(c, z.object({ setId: z.string().max(100), mode: z.enum(["practice", "contest"]) }));
    const [stats] = await db.query<{ total: number; maxPoints: number }>`
      select count(*) as total, coalesce(sum(t.points), 0) as max_points
      from tasks t join task_sets s on s.id = t.set_id where s.id = ${input.setId} and s.active = 1`;
    if (!stats?.total) throw notFound("Fant ikke oppgavesettet");
    const [created] = await db.query<{ id: string }>`
      insert into attempts (player_id, set_id, mode, max_points, total)
      output inserted.id
      values (${me.id}, ${input.setId}, ${input.mode}, ${stats.maxPoints}, ${stats.total})`;
    return c.json(await attemptView(await loadAttempt(created!.id, me.id)), 201);
  });

  // Hele settet til utskrift; fasit og løsningsforslag bare når det bes om (?fasit=1)
  app.get("/api/sets/:id/print", auth, async (c) => {
    const setId = c.req.param("id");
    const [set] = await db.query<{ id: string }>`
      select id, source, source_name, title, level_name, grades, year from task_sets where id = ${setId} and active = 1`;
    if (!set) throw notFound("Fant ikke oppgavesettet");
    const withAnswers = c.req.query("fasit") === "1";
    const tasks = await db.query<TaskRow>`select * from tasks where set_id = ${setId} order by n`;
    return c.json({
      ...set,
      maxPoints: tasks.reduce((sum, t) => sum + t.points, 0),
      tasks: tasks.map((t) => {
        const { answer: _mine, isCorrect: _ok, ...view } = taskView(t, undefined, withAnswers) as Record<string, unknown>;
        return view;
      }),
    });
  });

  app.get("/api/attempts/active", auth, async (c) => {
    const rows = await db.query<{ id: string }>`
      select a.id, a.set_id, s.title, a.mode, a.started_at, a.total,
             (select count(*) from attempt_answers x where x.attempt_id = a.id) as answered
      from attempts a join task_sets s on s.id = a.set_id
      where a.player_id = ${c.get("player").id} and a.finished_at is null
      order by a.started_at desc`;
    return c.json(rows.map((r) => ({ ...r, id: id(r.id) })));
  });

  app.get("/api/attempts/history", auth, async (c) => {
    const rows = await db.query<{ id: string }>`
      select top 200 a.id, a.set_id, s.title, a.mode, a.points, a.max_points, a.correct, a.total,
             a.elapsed_seconds, a.finished_at
      from attempts a join task_sets s on s.id = a.set_id
      where a.player_id = ${c.get("player").id} and a.finished_at is not null
      order by a.finished_at desc`;
    return c.json(rows.map((r) => ({ ...r, id: id(r.id) })));
  });

  app.get("/api/attempts/:id", auth, async (c) => {
    return c.json(await attemptView(await loadAttempt(c.req.param("id"), c.get("player").id)));
  });

  app.delete("/api/attempts/:id", auth, async (c) => {
    const a = await loadAttempt(c.req.param("id"), c.get("player").id);
    if (a.finishedAt) throw conflict("Forsøket er allerede levert");
    await db.query`delete from attempts where id = ${a.id}`;
    return c.json({ ok: true });
  });

  app.put("/api/attempts/:id/answers/:n", auth, async (c) => {
    const me = c.get("player");
    const a = await loadAttempt(c.req.param("id"), me.id);
    if (a.finishedAt) throw conflict("Forsøket er allerede levert");
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n)) throw notFound("Fant ikke oppgaven");
    const input = await body(c, z.object({ answer: z.string().max(50).nullable(), elapsedSeconds: Elapsed }));
    const [task] = await db.query<TaskRow>`select * from tasks where set_id = ${a.setId} and n = ${n}`;
    if (!task) throw notFound("Fant ikke oppgaven");
    const elapsed = clampElapsed(a, input.elapsedSeconds);
    const gradable = { ...task, options: task.options ? (JSON.parse(task.options) as string[]) : null };

    if (input.answer === null) {
      if (a.mode === "practice") throw conflict("Svar i øvingsmodus kan ikke angres");
      await db.query`delete from attempt_answers where attempt_id = ${a.id} and task_id = ${task.id}`;
    } else {
      const answer = normalizeAnswer(gradable, input.answer);
      if (answer === null) {
        throw new HTTPException(400, { message: task.kind === "number" ? "Skriv svaret som ett tall, for eksempel 12 eller 3,5" : "Ugyldig svar" });
      }
      const ok = isCorrect(gradable, answer);
      if (a.mode === "practice") {
        // Første svar teller og kan ikke endres
        const [res] = await db.tx((q) => q<{ inserted: number }>`
          insert into attempt_answers (attempt_id, task_id, answer, is_correct, points)
          select ${a.id}, ${task.id}, ${answer}, ${ok}, ${ok ? task.points : 0}
          where not exists (select 1 from attempt_answers with (updlock, holdlock)
                            where attempt_id = ${a.id} and task_id = ${task.id});
          select @@rowcount as inserted;`);
        if (!res?.inserted) throw conflict("Oppgaven er allerede besvart");
      } else {
        await db.query`
          merge attempt_answers with (holdlock) as t
          using (select ${a.id} as attempt_id, ${task.id} as task_id) as s
            on t.attempt_id = s.attempt_id and t.task_id = s.task_id
          when matched then update set
            answer = ${answer}, is_correct = ${ok}, points = ${ok ? task.points : 0}, answered_at = sysutcdatetime()
          when not matched then insert (attempt_id, task_id, answer, is_correct, points)
            values (s.attempt_id, s.task_id, ${answer}, ${ok}, ${ok ? task.points : 0});`;
      }
    }
    await db.query`update attempts set elapsed_seconds = ${elapsed} where id = ${a.id}`;
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
    if (a.finishedAt) throw conflict("Forsøket er allerede levert");
    const input = await body(c, z.object({ elapsedSeconds: Elapsed }));
    const elapsed = clampElapsed(a, input.elapsedSeconds);
    const [done] = await db.query<AttemptRow>`
      update attempts set
        finished_at = sysutcdatetime(),
        elapsed_seconds = ${elapsed},
        points = coalesce((select sum(points) from attempt_answers where attempt_id = ${a.id}), 0),
        correct = (select count(*) from attempt_answers where attempt_id = ${a.id} and is_correct = 1)
      output inserted.*
      where id = ${a.id} and finished_at is null`;
    if (!done) throw conflict("Forsøket er allerede levert");
    const [better] = await db.query<{ count: number }>`
      with ranked as (
        select a.player_id, a.points, a.elapsed_seconds,
               row_number() over (partition by a.player_id order by ${raw(BEST_ORDER)}) as rn
        from attempts a join players p on p.id = a.player_id
        where p.group_id = ${me.groupId} and a.set_id = ${a.setId} and a.finished_at is not null
          and a.player_id <> ${me.id}
      )
      select count(*) as count from ranked
      where rn = 1 and (points > ${done.points} or (points = ${done.points} and elapsed_seconds < ${done.elapsedSeconds}))`;
    const view = await attemptView({ ...done, title: a.title });
    return c.json({ ...view, rank: (better?.count ?? 0) + 1 });
  });

  // ---------- Toppliste (innenfor egen gruppe) ----------
  app.get("/api/leaderboard", auth, async (c) => {
    const me = c.get("player");
    const setId = c.req.query("set");
    const sets = await db.query`
      select distinct s.id, s.title, s.level, s.year
      from attempts a join players p on p.id = a.player_id join task_sets s on s.id = a.set_id
      where p.group_id = ${me.groupId} and a.finished_at is not null
      order by s.level, s.year desc`;

    if (setId) {
      const rows = await db.query<{ playerId: string }>`
        with ranked as (
          select a.player_id, p.name, a.mode, a.points, a.max_points, a.correct, a.total,
                 a.elapsed_seconds, a.finished_at,
                 row_number() over (partition by a.player_id order by ${raw(BEST_ORDER)}) as rn
          from attempts a join players p on p.id = a.player_id
          where p.group_id = ${me.groupId} and a.set_id = ${setId} and a.finished_at is not null
        )
        select player_id, name, mode, points, max_points, correct, total, elapsed_seconds, finished_at
        from ranked where rn = 1
        order by points desc, elapsed_seconds asc, finished_at asc`;
      return c.json({ sets, setId, rows: rows.map((r) => ({ ...r, playerId: id(r.playerId) })) });
    }

    const rows = await db.query<{ playerId: string }>`
      with ranked as (
        select a.player_id, a.set_id, a.points, a.correct, a.total,
               row_number() over (partition by a.player_id, a.set_id order by ${raw(BEST_ORDER)}) as rn
        from attempts a join players p on p.id = a.player_id
        where p.group_id = ${me.groupId} and a.finished_at is not null
      )
      select r.player_id, p.name, sum(r.points) as points, count(*) as sets,
             sum(r.correct) as correct, sum(r.total) as tasks
      from ranked r join players p on p.id = r.player_id
      where r.rn = 1
      group by r.player_id, p.name
      order by points desc, sets desc, p.name`;
    return c.json({ sets, setId: null, rows: rows.map((r) => ({ ...r, playerId: id(r.playerId) })) });
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
  // no-cache: nettleseren sjekker alltid etter ny versjon, så endringer når ut med en gang etter deploy
  app.use("/*", serveStatic({
    root: config.webDir,
    onFound: (_p, c) => { c.header("Cache-Control", "no-cache"); },
  }));

  return app;
}
