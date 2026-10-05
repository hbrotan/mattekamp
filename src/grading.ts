/** Retting per oppgavetype. Nye typer (tallsvar, tekst ...) legges til her. */
export interface GradableTask {
  kind: string;
  answer: string;
  options: string[] | null;
}

export function normalizeAnswer(task: GradableTask, raw: string): string | null {
  const value = raw.trim();
  switch (task.kind) {
    case "choice": {
      const upper = value.toUpperCase();
      return (task.options ?? []).includes(upper) ? upper : null;
    }
    default:
      return null;
  }
}

export function isCorrect(task: GradableTask, normalized: string): boolean {
  switch (task.kind) {
    case "choice":
      return normalized === task.answer;
    default:
      return false;
  }
}
