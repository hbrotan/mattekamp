import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { seedContent } from "../src/content.js";
import { connect, migrate, type Sql } from "../src/db.js";

// Kjører mot Postgres fra docker compose (npm run db:up). Lager en egen testdatabase.
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://mattekamp:mattekamp@localhost:5433/mattekamp";
const TEST_DB = "mattekamp_test";

let sql: Sql;
let app: ReturnType<typeof createApp>;
let contentDir: string;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();

  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), "mattekamp-test-"));
  await fs.mkdir(path.join(contentDir, "demo", "sett-1"), { recursive: true });
  await fs.writeFile(path.join(contentDir, "demo", "sett-1", "oppg01.png"), PNG);
  await fs.writeFile(path.join(contentDir, "demo", "sets.json"), JSON.stringify({
    source: "demo",
    sets: [{
      id: "sett-1", level: "ecolier", levelName: "Ecolier", grades: "4.–5. trinn", year: 2025,
      tasks: [
        { n: 1, points: 3, answer: "A", img: ["demo/sett-1/oppg01.png"], sol: ["demo/sett-1/oppg01.png"] },
        { n: 2, points: 4, answer: "B", img: ["demo/sett-1/oppg01.png"] },
        { n: 3, points: 5, answer: "C", img: ["demo/sett-1/oppg01.png"] },
      ],
    }],
  }));

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  sql = connect(url.toString());
  await migrate(sql, path.resolve("migrations"));
  await seedContent(sql, contentDir);
  const config: Config = {
    port: 0, databaseUrl: url.toString(), secureCookies: false,
    webDir: path.resolve("web"), contentDir, migrationsDir: path.resolve("migrations"),
  };
  app = createApp(sql, config);
});

afterAll(async () => {
  await sql?.end();
  if (contentDir) await fs.rm(contentDir, { recursive: true, force: true });
});

/** Liten klient som husker innloggings-cookien, som en nettleser. */
function client() {
  let cookie = "";
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, json: json as any, res };
  };
  return {
    get: (u: string) => call("GET", u),
    post: (u: string, b: unknown = {}) => call("POST", u, b),
    put: (u: string, b: unknown) => call("PUT", u, b),
    del: (u: string) => call("DELETE", u),
  };
}

describe("grupper og innlogging", () => {
  it("lager gruppe og lar andre bli med med koden", async () => {
    const ola = client();
    const created = await ola.post("/api/groups", { groupName: "Klasse 5B", playerName: "Ola" });
    expect(created.status).toBe(201);
    expect(created.json.group.code).toMatch(/^[A-Z2-9]{6}$/);

    const kari = client();
    const joined = await kari.post("/api/session", { code: created.json.group.code.toLowerCase(), name: "Kari" });
    expect(joined.status).toBe(200);
    expect(joined.json.group.name).toBe("Klasse 5B");

    const players = await kari.get("/api/group/players");
    expect(players.json).toEqual(["Kari", "Ola"]);
  });

  it("samme navn i samme gruppe gir samme spiller", async () => {
    const a = client();
    const { json: g } = await a.post("/api/groups", { groupName: "Familien", playerName: "Per" });
    const b = client();
    const { json: again } = await b.post("/api/session", { code: g.group.code, name: "  per " });
    expect(again.player.id).toBe(g.player.id);
  });

  it("avviser ukjent kode, manglende innlogging og ikke-JSON", async () => {
    const c = client();
    expect((await c.post("/api/session", { code: "XXXXXX", name: "A" })).status).toBe(404);
    expect((await c.get("/api/sets")).status).toBe(401);
    const res = await app.request("/api/session", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("logger ut", async () => {
    const c = client();
    await c.post("/api/groups", { groupName: "G", playerName: "P" });
    expect((await c.get("/api/session")).status).toBe(200);
    await c.del("/api/session");
    expect((await c.get("/api/session")).status).toBe(401);
  });
});

describe("forsøk og poeng", () => {
  it("øving: viser fasit med en gang og låser svaret", async () => {
    const c = client();
    await c.post("/api/groups", { groupName: "G", playerName: "P" });
    const { json: attempt } = await c.post("/api/attempts", { setId: "demo-sett-1", mode: "practice" });
    expect(attempt.tasks[0]).not.toHaveProperty("correctAnswer");

    const first = await c.put(`/api/attempts/${attempt.id}/answers/1`, { answer: "a" });
    expect(first.json.task).toMatchObject({ answer: "A", isCorrect: true, correctAnswer: "A" });
    expect(first.json.task.solution).toEqual(["/assets/demo/sett-1/oppg01.png"]);
    expect(first.json.points).toBe(3);

    expect((await c.put(`/api/attempts/${attempt.id}/answers/1`, { answer: "B" })).status).toBe(409);
    expect((await c.put(`/api/attempts/${attempt.id}/answers/2`, { answer: "F" })).status).toBe(400);
  });

  it("konkurranse: skjuler fasit og poeng til innlevering, og regner 3/4/5 poeng", async () => {
    const c = client();
    await c.post("/api/groups", { groupName: "G", playerName: "P" });
    const { json: attempt } = await c.post("/api/attempts", { setId: "demo-sett-1", mode: "contest" });

    const ans = await c.put(`/api/attempts/${attempt.id}/answers/1`, { answer: "B" });
    expect(ans.json.task).not.toHaveProperty("correctAnswer");
    expect(ans.json.points).toBeNull();
    await c.put(`/api/attempts/${attempt.id}/answers/1`, { answer: "A" }); // kan ombestemme seg
    await c.put(`/api/attempts/${attempt.id}/answers/2`, { answer: "C" }); // feil
    await c.put(`/api/attempts/${attempt.id}/answers/3`, { answer: "C" }); // riktig

    const done = await c.post(`/api/attempts/${attempt.id}/finish`, { elapsedSeconds: 1 });
    expect(done.json).toMatchObject({ finished: true, points: 8, correct: 2, maxPoints: 12, rank: 1 });
    expect(done.json.tasks[1]).toMatchObject({ answer: "C", isCorrect: false, correctAnswer: "B" });
    expect((await c.post(`/api/attempts/${attempt.id}/finish`, {})).status).toBe(409);
  });

  it("andre kan ikke se eller endre forsøket mitt", async () => {
    const me = client();
    await me.post("/api/groups", { groupName: "G", playerName: "P" });
    const { json: attempt } = await me.post("/api/attempts", { setId: "demo-sett-1", mode: "contest" });
    const other = client();
    await other.post("/api/groups", { groupName: "H", playerName: "Q" });
    expect((await other.get(`/api/attempts/${attempt.id}`)).status).toBe(404);
    expect((await other.put(`/api/attempts/${attempt.id}/answers/1`, { answer: "A" })).status).toBe(404);
  });
});

describe("toppliste", () => {
  it("viser beste resultat per person, bare i egen gruppe", async () => {
    const ola = client();
    const { json: g } = await ola.post("/api/groups", { groupName: "Toppgruppe", playerName: "Ola" });
    const kari = client();
    await kari.post("/api/session", { code: g.group.code, name: "Kari" });
    const outsider = client();
    await outsider.post("/api/groups", { groupName: "Annen", playerName: "Utenfor" });

    const play = async (c: ReturnType<typeof client>, answers: string[]) => {
      const { json: a } = await c.post("/api/attempts", { setId: "demo-sett-1", mode: "contest" });
      for (const [i, ans] of answers.entries()) await c.put(`/api/attempts/${a.id}/answers/${i + 1}`, { answer: ans });
      return (await c.post(`/api/attempts/${a.id}/finish`, {})).json;
    };
    await play(ola, ["A", "D", "D"]); // 3 poeng
    await play(ola, ["A", "B", "D"]); // 7 poeng – beste
    const kariResult = await play(kari, ["A", "B", "C"]); // 12 poeng
    expect(kariResult.rank).toBe(1);
    await play(outsider, ["A", "B", "C"]);

    const board = await ola.get("/api/leaderboard?set=demo-sett-1");
    expect(board.json.rows.map((r: any) => [r.name, r.points])).toEqual([["Kari", 12], ["Ola", 7]]);
    const totals = await ola.get("/api/leaderboard");
    expect(totals.json.rows.map((r: any) => [r.name, r.points, r.sets])).toEqual([["Kari", 12, 1], ["Ola", 7, 1]]);
  });
});

describe("bilder", () => {
  it("krever innlogging og serverer bare bildefiler", async () => {
    const anon = await app.request("/assets/demo/sett-1/oppg01.png");
    expect(anon.status).toBe(401);
    const c = client();
    await c.post("/api/groups", { groupName: "G", playerName: "P" });
    const img = await c.get("/assets/demo/sett-1/oppg01.png");
    expect(img.status).toBe(200);
    expect(img.res.headers.get("content-type")).toBe("image/png");
    expect((await c.get("/assets/demo/sets.json")).status).toBe(404);
  });
});
