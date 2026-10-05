"""Bygger content/nasjonale-prover/sets.json fra utkastene i content/nasjonale-prover/drafts/.

Øvingsprøvene er Mattekamps egne oppgaver i stil med nasjonale prøver i regning (ikke Udirs prøver).
Oppgavene står fra lett til vanskelig; første tredjedel gir 3 poeng, neste 4 og siste 5.

Bruk:
    python tools/np_build.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "content" / "nasjonale-prover"
LEVELS = {"5-trinn": "5. trinn", "8-9-trinn": "8.–9. trinn"}
KEYS = ["A", "B", "C", "D", "E"]
NUMBER = re.compile(r"^−?-?\d+(,\d+)?$")


def points_for(i: int, n: int) -> int:
    return 3 if i < n / 3 else 4 if i < 2 * n / 3 else 5


def main() -> int:
    errors, sets = [], []
    for f in sorted((ROOT / "drafts").glob("*.json")):
        draft = json.loads(f.read_text(encoding="utf-8"))
        level = draft["level"]
        if level not in LEVELS:
            errors.append(f"{f.name}: ukjent nivå {level}")
            continue
        tasks = []
        n = len(draft["tasks"])
        for i, t in enumerate(draft["tasks"]):
            where = f"{f.name} oppgave {i + 1}"
            task = {"n": i + 1, "points": points_for(i, n), "kind": t["kind"], "text": t["text"],
                    "answer": t["answer"], "explanation": t.get("explanation", "")}
            if t.get("table"):
                task["table"] = dict(t["table"])
                if re.search(r"søylediagram", t["text"], re.I):
                    task["table"]["chart"] = "bar"
                    task["table"]["showTable"] = bool(re.search(r"tabell", t["text"], re.I))
            if t["kind"] == "choice":
                if sorted(t.get("choices", {})) != KEYS or t["answer"] not in KEYS:
                    errors.append(f"{where}: ugyldige svaralternativer")
                    continue
                task["choices"] = {k: t["choices"][k] for k in KEYS}
            elif t["kind"] == "number":
                if not NUMBER.match(t["answer"].replace(" ", "")):
                    errors.append(f"{where}: fasit er ikke ett tall ({t['answer']})")
                    continue
                # Samme form som appen bruker: ekte minustegn, ingen mellomrom
                task["answer"] = t["answer"].replace(" ", "").replace("-", "−")
                if t.get("unit"):
                    task["unit"] = t["unit"]
            else:
                errors.append(f"{where}: ukjent type {t['kind']}")
                continue
            tasks.append(task)
        sets.append({
            "id": draft["id"],
            "level": level,
            "levelName": LEVELS[level],
            "grades": "Øvingsprøver i regning",
            "title": draft["title"],
            "tasks": tasks,
        })

    sets.sort(key=lambda s: (list(LEVELS).index(s["level"]), s["id"]))
    out = {"source": "nasjonale-prover", "sourceName": "Nasjonale prøver", "sets": sets}
    (ROOT / "sets.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Skrev {len(sets)} prøver med {sum(len(s['tasks']) for s in sets)} oppgaver til {ROOT / 'sets.json'}")
    for e in errors:
        print("  ADVARSEL:", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
