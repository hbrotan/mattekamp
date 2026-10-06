/** Retting per oppgavetype. Nye typer (tekst ...) legges til her. */
export interface GradableTask {
  kind: string;
  answer: string;
  options: string[] | null;
}

/**
 * Leser et tall slik elever skriver det: desimalkomma eller -punktum, mellomrom som tusenskille,
 * og vanlig minus eller «−». Gir null hvis det ikke er ett tall.
 */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/[\s ]+/g, "").replace(/[−–]/g, "-").replace(",", ".");
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return Number(s);
}

/** Tall på norsk form: 12,5 og −3 (uten unødvendige nuller). */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 1e9) / 1e9;
  return String(rounded).replace("-", "−").replace(".", ",");
}

export function normalizeAnswer(task: GradableTask, raw: string): string | null {
  const value = raw.trim();
  switch (task.kind) {
    case "choice": {
      const upper = value.toUpperCase();
      return (task.options ?? []).includes(upper) ? upper : null;
    }
    case "number": {
      const n = parseNumber(value);
      return n === null ? null : formatNumber(n);
    }
    default:
      return null;
  }
}

export function isCorrect(task: GradableTask, normalized: string): boolean {
  switch (task.kind) {
    case "choice":
      return normalized === task.answer;
    case "number": {
      const given = parseNumber(normalized);
      const expected = parseNumber(task.answer);
      return given !== null && expected !== null && Math.abs(given - expected) < 1e-9;
    }
    default:
      return false;
  }
}
