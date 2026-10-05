"""Bygger content/getsmart/sets.json fra videokatalogen og våre egne oppgaver.

Inndata:
  content/getsmart/catalog.json      – videoene (fra tools/getsmart_fetch.py)
  content/getsmart/questions/*.json  – våre egne flervalgsoppgaver, to per video

Hvert GetSmart-emne blir ett oppgavesett. Hver oppgave viser videoen den hører til, slik at
man kan se forklaringen før man svarer. Emnene grupperes i samme områder som på getsmart.no.

Bruk:
    python tools/getsmart_build.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "content" / "getsmart"

# Område (nøkkel, navn) per emne, i samme rekkefølge som på getsmart.no
AREAS = [
    ("tall", "Tall og tallregning", ["tallaere", "tallregning", "broekregning", "prosentregning", "tallregning_med_potenser", "getsmart_divisjon"]),
    ("algebra", "Algebra", ["grunnleggende_regler_i_algebra", "faktorisering_av_algebrauttrykk", "figurtall_og_tallmoenstre",
                            "getsmart_figurtall_og_tallmoenstre", "broekregning_med_variabler", "potensregning_med_variabler",
                            "kvadratsetningene"]),
    ("likninger", "Likninger", ["foerstegradslikninger", "andregradslikninger", "ulikheter", "formelregning",
                                "likninger_med_to_ukjente", "uoppstilte_likninger"]),
    ("funksjoner", "Funksjoner", ["lineaere_funksjoner", "ikke-lineaere_funksjoner", "lineaer_tilnaerming"]),
    ("geometri", "Geometri", ["geometriske_grunnbegreper", "polygoner", "pythagoras_laeresetning", "formlikhet_og_kongruens",
                              "problemloesning_i_geometri", "getsmart_geometry"]),
    ("maaling", "Måling", ["maaleenheter"]),
    ("problemloesning", "Problemløsning", ["problemloesning"]),
    ("sannsynlighet", "Sannsynlighet og kombinatorikk", ["teoretisk_sannsynlighet", "kombinatorikk",
                                                          "sannsynlighet_basert_paa_erfaringer", "sammensatt_sannsynlighet"]),
    ("statistikk", "Statistikk og regneark", ["diagrammer", "analyse_av_datamateriale", "regneark"]),
]
KEYS = ["A", "B", "C", "D", "E"]


def main() -> int:
    catalog = {t["slug"]: t for t in json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))}
    errors, sets = [], []
    for area, area_name, slugs in AREAS:
        for slug in slugs:
            topic = catalog[slug]
            qfile = ROOT / "questions" / f"{slug}.json"
            if not qfile.exists():
                errors.append(f"{slug}: mangler oppgaver ({qfile.name})")
                continue
            written = {v["code"]: v["questions"] for v in json.loads(qfile.read_text(encoding="utf-8"))["videos"]}
            tasks = []
            for video in topic["videos"]:
                questions = written.get(video["code"])
                if not questions:
                    errors.append(f"{slug}/{video['code']}: mangler oppgaver")
                    continue
                for q in questions:
                    if sorted(q["choices"]) != KEYS or q["answer"] not in KEYS:
                        errors.append(f"{slug}/{video['code']}: ugyldige svaralternativer")
                        continue
                    tasks.append({
                        "n": len(tasks) + 1,
                        "points": q["points"],
                        "answer": q["answer"],
                        "text": q["text"],
                        "choices": {k: q["choices"][k] for k in KEYS},
                        "video": {"youtubeId": video["youtubeId"], "title": video["title"]},
                        "explanation": q.get("explanation", ""),
                    })
            if tasks:
                sets.append({
                    "id": slug.replace("_", "-"),
                    "level": area,
                    "levelName": area_name,
                    "grades": "8.–10. trinn",
                    "title": topic["name"],
                    "tasks": tasks,
                })

    out = {"source": "getsmart", "sourceName": "GetSmart", "sets": sets}
    (ROOT / "sets.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Skrev {len(sets)} sett med {sum(len(s['tasks']) for s in sets)} oppgaver til {ROOT / 'sets.json'}")
    for e in errors:
        print("  ADVARSEL:", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
