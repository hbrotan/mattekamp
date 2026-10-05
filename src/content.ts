import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";

/**
 * Innholdsfiler: content/<kilde>/sets.json. Hver kilde (kenguru, senere andre)
 * leverer oppgavesett i dette formatet; bildestier er relative til content/.
 */
const TaskFile = z.object({
  n: z.number().int().positive(),
  points: z.number().int().positive(),
  kind: z.enum(["choice"]).default("choice"),
  answer: z.string().min(1),
  options: z.array(z.string()).optional(),
  img: z.array(z.string()).min(1),
  sol: z.array(z.string()).default([]),
});

const SetFile = z.object({
  id: z.string().min(1),
  level: z.string(),
  levelName: z.string(),
  grades: z.string().default(""),
  year: z.number().int().optional(),
  tasks: z.array(TaskFile).min(1),
});

const SourceFile = z.object({
  source: z.string().regex(/^[a-z0-9-]+$/),
  sets: z.array(SetFile),
});

const DEFAULT_OPTIONS = ["A", "B", "C", "D", "E"];

/** Leser alle content/<kilde>/sets.json og oppdaterer task_sets/tasks. */
export async function seedContent(db: Db, contentDir: string): Promise<{ sets: number; tasks: number; skipped: number }> {
  let sets = 0, tasks = 0, skipped = 0;
  const entries = await fs.readdir(contentDir, { withFileTypes: true });
  for (const dir of entries.filter((e) => e.isDirectory())) {
    const file = path.join(contentDir, dir.name, "sets.json");
    let raw: string;
    try { raw = await fs.readFile(file, "utf8"); } catch { continue; }
    const data = SourceFile.parse(JSON.parse(raw));
    const hash = createHash("sha256").update(raw).digest("hex");

    // Uendret innhold lastes ikke på nytt – gjør kald oppstart rask
    const [current] = await db.query<{ hash: string }>`select hash from content_versions where source = ${data.source}`;
    if (current?.hash === hash) { skipped++; continue; }

    const setRows = data.sets.map((s, index) => ({
      id: `${data.source}-${s.id}`,
      source: data.source,
      title: s.year ? `${s.levelName} ${s.year}` : s.levelName,
      level: s.level,
      level_name: s.levelName,
      grades: s.grades,
      year: s.year ?? null,
      sort_key: index,
    }));
    const taskRows = data.sets.flatMap((s) => s.tasks.map((t) => ({
      id: `${data.source}-${s.id}-${t.n}`,
      set_id: `${data.source}-${s.id}`,
      n: t.n,
      kind: t.kind,
      points: t.points,
      prompt: JSON.stringify({ images: t.img }),
      options: JSON.stringify(t.options ?? DEFAULT_OPTIONS),
      answer: t.answer,
      solution: JSON.stringify({ images: t.sol }),
    })));

    // Hele kilden sendes som ett JSON-parameter og flettes inn med MERGE (én rundtur)
    await db.tx(async (q) => {
      await q`
        merge task_sets as t
        using (select * from openjson(${JSON.stringify(setRows)}) with (
          id varchar(100), source varchar(50), title nvarchar(100), level varchar(50),
          level_name nvarchar(100), grades nvarchar(100), year int, sort_key int)) as s
        on t.id = s.id
        when matched then update set
          title = s.title, level = s.level, level_name = s.level_name, grades = s.grades,
          year = s.year, sort_key = s.sort_key, active = 1
        when not matched then insert (id, source, title, level, level_name, grades, year, sort_key)
          values (s.id, s.source, s.title, s.level, s.level_name, s.grades, s.year, s.sort_key);`;
      await q`
        merge tasks as t
        using (select * from openjson(${JSON.stringify(taskRows)}) with (
          id varchar(120), set_id varchar(100), n int, kind varchar(20), points int,
          prompt nvarchar(max), options nvarchar(max), answer nvarchar(50), solution nvarchar(max))) as s
        on t.id = s.id
        when matched then update set
          kind = s.kind, points = s.points, prompt = s.prompt, options = s.options,
          answer = s.answer, solution = s.solution
        when not matched then insert (id, set_id, n, kind, points, prompt, options, answer, solution)
          values (s.id, s.set_id, s.n, s.kind, s.points, s.prompt, s.options, s.answer, s.solution);`;
      await q`
        merge content_versions as t
        using (select ${data.source} as source, ${hash} as hash) as s on t.source = s.source
        when matched then update set hash = s.hash, loaded_at = sysutcdatetime()
        when not matched then insert (source, hash) values (s.source, s.hash);`;
    });
    sets += setRows.length;
    tasks += taskRows.length;
  }
  return { sets, tasks, skipped };
}
