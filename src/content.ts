import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Sql } from "./db.js";

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
export async function seedContent(sql: Sql, contentDir: string): Promise<{ sets: number; tasks: number; skipped: number }> {
  let sets = 0, tasks = 0, skipped = 0;
  const entries = await fs.readdir(contentDir, { withFileTypes: true });
  for (const dir of entries.filter((e) => e.isDirectory())) {
    const file = path.join(contentDir, dir.name, "sets.json");
    let raw: string;
    try { raw = await fs.readFile(file, "utf8"); } catch { continue; }
    const data = SourceFile.parse(JSON.parse(raw));
    const hash = createHash("sha256").update(raw).digest("hex");

    // Uendret innhold lastes ikke på nytt – gjør kald oppstart rask
    const [current] = await sql<{ hash: string }[]>`select hash from content_versions where source = ${data.source}`;
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
      // sql.json: ellers blir JS-lister sendt som Postgres-arrayer, ikke jsonb
      prompt: sql.json({ images: t.img }),
      options: sql.json(t.options ?? DEFAULT_OPTIONS),
      answer: t.answer,
      solution: sql.json({ images: t.sol }),
    })));

    await sql.begin(async (tx) => {
      await tx`
        insert into task_sets ${tx(setRows)}
        on conflict (id) do update set
          title = excluded.title, level = excluded.level, level_name = excluded.level_name,
          grades = excluded.grades, year = excluded.year, sort_key = excluded.sort_key, active = true`;
      for (let i = 0; i < taskRows.length; i += 500) {
        await tx`
          insert into tasks ${tx(taskRows.slice(i, i + 500))}
          on conflict (id) do update set
            kind = excluded.kind, points = excluded.points, prompt = excluded.prompt,
            options = excluded.options, answer = excluded.answer, solution = excluded.solution`;
      }
      await tx`
        insert into content_versions (source, hash) values (${data.source}, ${hash})
        on conflict (source) do update set hash = excluded.hash, loaded_at = now()`;
    });
    sets += setRows.length;
    tasks += taskRows.length;
  }
  return { sets, tasks, skipped };
}
