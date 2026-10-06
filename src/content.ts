import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { parseNumber } from "./grading.js";

/**
 * Innholdsfiler: content/<kilde>/sets.json. Hver kilde (kenguru, getsmart ...) leverer
 * oppgavesett i dette formatet; bildestier er relative til content/.
 *
 * En oppgave er enten et bilde (Kenguru: spørsmål og alternativer står i bildet) eller tekst
 * med svaralternativer i `choices`. Den kan ha en YouTube-video som forklarer emnet og en tabell.
 * Oppgavetyper: «choice» (velg A–E) og «number» (skriv inn ett tall; `unit` vises bak svarfeltet).
 */
const Table = z.object({
  headers: z.array(z.string()).min(1).max(8),
  rows: z.array(z.array(z.string())).min(1).max(20),
  chart: z.enum(["bar"]).optional(),
  showTable: z.boolean().optional(),
});

const TaskFile = z.object({
  n: z.number().int().positive(),
  points: z.number().int().positive(),
  kind: z.enum(["choice", "number"]).default("choice"),
  answer: z.string().min(1),
  options: z.array(z.string()).optional(),
  img: z.array(z.string()).default([]),
  text: z.string().optional(),
  choices: z.record(z.string(), z.string()).optional(),
  video: z.object({ youtubeId: z.string().regex(/^[A-Za-z0-9_-]{6,20}$/), title: z.string() }).optional(),
  table: Table.optional(),
  unit: z.string().max(20).optional(),
  sol: z.array(z.string()).default([]),
  explanation: z.string().optional(),
}).refine((t) => t.img.length > 0 || t.text, "Oppgaven må ha bilde eller tekst")
  .refine((t) => t.kind !== "choice" || !t.choices || t.answer in t.choices, "Fasiten må være et av svaralternativene")
  .refine((t) => t.kind !== "number" || (!!t.text && parseNumber(t.answer) !== null), "Tallsvar må ha tekst og et tall som fasit");

const SetFile = z.object({
  id: z.string().min(1),
  level: z.string(),
  levelName: z.string(),
  grades: z.string().default(""),
  year: z.number().int().optional(),
  title: z.string().optional(),
  tasks: z.array(TaskFile).min(1),
});

const SourceFile = z.object({
  source: z.string().regex(/^[a-z0-9-]+$/),
  sourceName: z.string().optional(),
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
      source_name: data.sourceName ?? data.source,
      title: s.title ?? (s.year ? `${s.levelName} ${s.year}` : s.levelName),
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
      prompt: JSON.stringify({ images: t.img, text: t.text, choices: t.choices, video: t.video, table: t.table, unit: t.unit }),
      options: t.kind === "number" ? null : JSON.stringify(t.options ?? (t.choices ? Object.keys(t.choices) : DEFAULT_OPTIONS)),
      answer: t.answer,
      solution: JSON.stringify({ images: t.sol, text: t.explanation }),
    })));

    // Hele kilden sendes som ett JSON-parameter og flettes inn med MERGE (én rundtur)
    await db.tx(async (q) => {
      await q`
        merge task_sets as t
        using (select * from openjson(${JSON.stringify(setRows)}) with (
          id varchar(100), source varchar(50), source_name nvarchar(50), title nvarchar(100), level varchar(50),
          level_name nvarchar(100), grades nvarchar(100), year int, sort_key int)) as s
        on t.id = s.id
        when matched then update set
          source_name = s.source_name, title = s.title, level = s.level, level_name = s.level_name, grades = s.grades,
          year = s.year, sort_key = s.sort_key, active = 1
        when not matched then insert (id, source, source_name, title, level, level_name, grades, year, sort_key)
          values (s.id, s.source, s.source_name, s.title, s.level, s.level_name, s.grades, s.year, s.sort_key);`;
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
