"""Bygger oppgavebildene og content/kenguru/sets.json for Kenguru-oppgavene.

Leser oppgave- og løsnings-PDF-er (bokmål) fra Matematikksenterets oppgavebank,
klipper ut hver oppgave og hvert løsningsforslag som PNG og henter fasiten.

Bruk:
    python tools/kenguru_extract.py <mappe-med-pdf-er>

PDF-ene lastes ned fra
https://www.matematikksenteret.no/læringsressurser/kenguru/kenguruoppgaver-oppgavebank
"""
import io
import json
import re
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = "kenguru"
OUT_DIR = ROOT / "content" / SOURCE
ZOOM = 2

# Rekkefølgen betyr noe: Pre-Ecolier må sjekkes før Ecolier.
LEVELS = [
    ("preecolier", r"pre\s*-?\s*ecolier", "Pre-Ecolier", "1.–3. trinn"),
    ("ecolier", r"ecolier", "Ecolier", "4.–5. trinn"),
    ("duo", r"duo", "Kenguru DUO", "4.–6. trinn, par"),
    ("benjamin", r"ben[ja]+min", "Benjamin", "6.–8. trinn"),
    ("cadet", r"cadet", "Cadet", "9.–10. trinn"),
]
SOLUTION_RE = re.compile(r"løsning|loesning|fasit", re.I)
HEADER_RE = re.compile(r"^((kengurukonkurransen|kenguru|parkonkurranse|(pre-?)?ecolier|benjamin|cadet|duo)\b|\d{1,4}\s*$)", re.I)
STOP_RE = re.compile(
    r"^(fasit med korte|mange matematiske|[345]\s*-?\s*poeng\s*$|svarskjema|registreringsskjema|høyeste mulige)", re.I
)

OPTION_RE = re.compile(r"^\(?[A-E]\)")


def classify(path):
    name = path.stem
    year = re.search(r"20\d\d", name)
    if not year:
        return None
    for key, pattern, label, grades in LEVELS:
        if re.search(pattern, name, re.I):
            kind = "sol" if SOLUTION_RE.search(name) else "task"
            return key, label, grades, int(year.group()), kind
    return None


def page_lines(page):
    out = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text:
                out.append((pymupdf.Rect(line["bbox"]), text))
    out.sort(key=lambda t: (round(t[0].y0), t[0].x0))
    return out


def page_limits(page, lines):
    """Toppen (under topptekst) og bunnen (over sidetall) av innholdet på en side,
    pluss topptekst-elementer som må males over hvis en figur stikker opp i topptekstfeltet."""
    w, h = page.rect.width, page.rect.height
    top, bottom, masks = 0.0, h - 15, []
    for rect, text in lines:
        if rect.y1 < h * 0.13 and HEADER_RE.match(text):
            top = max(top, rect.y1 + 2)
            masks.append(rect)
        if rect.y0 > h * 0.85 and re.fullmatch(r"\d{1,2}", text):
            bottom = min(bottom, rect.y0 - 2)
    # Vannrette streker i topp- og bunntekst
    for d in page.get_drawings():
        r = d["rect"]
        if r.width > w * 0.5 and r.height < 5:
            if r.y1 < h * 0.15:
                top = max(top, r.y1 + 2)
                masks.append(r)
            elif r.y0 > h * 0.85:
                bottom = min(bottom, r.y0 - 2)
    images = [pymupdf.Rect(info["bbox"]) for info in page.get_image_info()]
    # Logo i bunnteksten
    for r in images:
        if r.y0 > h * 0.88:
            bottom = min(bottom, r.y0 - 2)
    # Figur som stikker opp i topptekstfeltet: ta den med, mal over toppteksten
    header_top = top
    for r in images:
        if r.y0 < header_top < r.y1 and r.height > 40:
            top = min(top, r.y0 - 1)
        elif r.y1 <= header_top:
            masks.append(r)
    return top, bottom, masks


def blank_cut(page, y_lo, y_hi, min_gap=6, fallback=None):
    """Midten av det nærmeste hvite båndet over y_hi (minst min_gap pt høyt), ellers fallback/y_hi."""
    fallback = y_hi if fallback is None else fallback
    if y_hi - y_lo < 4:
        return fallback
    clip = pymupdf.Rect(0, y_lo, page.rect.width, y_hi)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1), clip=clip, colorspace=pymupdf.csGRAY, alpha=False)
    data, scale = pix.samples, (y_hi - y_lo) / pix.height
    run_end = None
    for row in range(pix.height - 1, -2, -1):
        blank = row >= 0 and min(data[row * pix.stride: row * pix.stride + pix.width]) > 225
        if blank and run_end is None:
            run_end = row + 1
        elif not blank and run_end is not None:
            if (run_end - row - 1) * scale >= min_gap or row < 0:
                return y_lo + (row + 1 + run_end) / 2 * scale
            run_end = None
    return fallback


def has_content(lines, y0, y1):
    return any(y0 <= r.y0 and r.y1 <= y1 + 2 and not HEADER_RE.match(t) for r, t in lines)


def find_starts(doc, all_lines, start_re, count=None):
    """Finn (side, y) for starten på oppgave 1, 2, 3 ... i rekkefølge."""
    starts, expected = [], 1
    for pno, lines in enumerate(all_lines):
        for rect, text in lines:
            m = start_re.match(text)
            if m and int(m.group(1)) == expected:
                starts.append((pno, rect.y0, rect.x0))
                expected += 1
                if count and expected > count:
                    return starts
    return starts


def stop_between(lines, y_from, y_to):
    for rect, text in lines:
        if y_from + 5 < rect.y0 < y_to and STOP_RE.match(text):
            return rect.y0 - 2
    return y_to


def render(page, y0, y1, masks=()):
    if y1 - y0 < 8:
        return None
    clip = pymupdf.Rect(0, y0, page.rect.width, y1)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip, alpha=False)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    # Mal over «3 poeng»-overskrifter o.l. som havner inni utsnittet
    draw = ImageDraw.Draw(img)
    for r in masks:
        if r.y1 > y0 and r.y0 < y1:
            draw.rectangle([(r.x0 - 1) * ZOOM, (r.y0 - y0 - 1) * ZOOM, (r.x1 + 1) * ZOOM, (r.y1 - y0 + 1) * ZOOM], fill="white")
    diff = ImageChops.difference(img, Image.new("RGB", img.size, "white")).convert("L")
    bbox = diff.point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox or bbox[3] - bbox[1] < 12:
        return None
    pad = 16
    box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(img.width, bbox[2] + pad), min(img.height, bbox[3] + pad))
    return img.crop(box)


def crop_items(doc, starts, out_dir, prefix):
    all_lines = [page_lines(p) for p in doc]
    limits = [page_limits(p, l) for p, l in zip(doc, all_lines)]
    # Kuttet over hver oppgave legges i et hvitt bånd, slik at figurer som
    # står litt høyere enn oppgavenummeret blir med i riktig oppgave.
    cuts = []
    for i, (pno, y, _x) in enumerate(starts):
        lo = max(limits[pno][0], y - 70)
        if i and starts[i - 1][0] == pno:
            lo = max(lo, starts[i - 1][1] + 12)
        # Svaralternativene over hører til forrige oppgave: aldri kutt over dem
        opts = [r.y1 for r, t in all_lines[pno] if OPTION_RE.match(t) and lo < r.y1 <= y]
        first_on_page = not (i and starts[i - 1][0] == pno)
        if opts:
            lo = max(opts) + 0.5
            cuts.append(blank_cut(doc[pno], lo, y - 1, fallback=lo))
        elif first_on_page and not has_content(all_lines[pno], limits[pno][0], y - 1):
            cuts.append(limits[pno][0])
        else:
            cuts.append(blank_cut(doc[pno], lo, y - 1))
    result = []
    for i, (pno, y, _x) in enumerate(starts):
        nxt = starts[i + 1] if i + 1 < len(starts) else None
        segments = []
        if nxt and nxt[0] == pno:
            segments.append((pno, cuts[i], stop_between(all_lines[pno], y, cuts[i + 1])))
        else:
            segments.append((pno, cuts[i], stop_between(all_lines[pno], y, limits[pno][1])))
            if nxt:
                for q in range(pno + 1, nxt[0] + 1):
                    top, bottom, _m = limits[q]
                    end = cuts[i + 1] if q == nxt[0] else bottom
                    end = stop_between(all_lines[q], top - 6, end)
                    if has_content(all_lines[q], top, end):
                        segments.append((q, top, end))
        files = []
        for k, (q, a, b) in enumerate(segments):
            masks = [r for r, t in all_lines[q] if STOP_RE.match(t)] + limits[q][2]
            img = render(doc[q], a, b, masks)
            if img is None:
                continue
            name = f"{prefix}{i + 1:02d}{'' if k == 0 else chr(ord('a') + k)}.png"
            img = img.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
            img.save(out_dir / name, optimize=True)
            files.append(f"{SOURCE}/{out_dir.name}/{name}")
        result.append(files)
    return result


def find_answers(doc, n):
    """Fasit fra løsningsteksten («7. (C) ...»), med svartabellen bakerst som reserve."""
    text = "\n".join(p.get_text() for p in doc)
    table = dict(re.findall(r"(?m)^\s*(\d{1,2})\s*\n\s*([A-E])\s*\n\s*[345]\s*$", text))
    answers, pos = [], 0
    for i in range(1, n + 1):
        m = re.compile(rf"(?m)^\s*{i}\s*(?:\.\s*\(?|\()\s*([A-E])\s*\)").search(text, pos)
        if m:
            answers.append(m.group(1))
            pos = m.end()
        else:
            answers.append(table.get(str(i)))
    return answers


def points_for(i, n):
    third = n / 3
    return 3 if i < third else 4 if i < 2 * third else 5


def main(pdf_dir):
    groups = {}
    for path in sorted(Path(pdf_dir).glob("*.pdf")):
        info = classify(path)
        if info:
            key, label, grades, year, kind = info
            groups.setdefault((key, year), {"label": label, "grades": grades})[kind] = path

    task_re = re.compile(r"^(\d{1,2})\s*\.(\s|$)")
    sol_re = re.compile(r"^(\d{1,2})\s*(?:\.\s*\(?|\()\s*[A-E]\s*\)")
    order = {k: i for i, (k, *_r) in enumerate(LEVELS)}
    sets = []
    for (key, year), g in sorted(groups.items(), key=lambda kv: (-kv[0][1], order[kv[0][0]])):
        if "task" not in g or "sol" not in g:
            print(f"hopper over {key} {year}: mangler {'fasit' if 'task' in g else 'oppgaver'}")
            continue
        set_id = f"{key}-{year}"
        out_dir = OUT_DIR / set_id
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.glob("*.png"):
            old.unlink()

        tdoc, sdoc = pymupdf.open(g["task"]), pymupdf.open(g["sol"])
        t_lines = [page_lines(p) for p in tdoc]
        t_starts = find_starts(tdoc, t_lines, task_re)
        n = len(t_starts)
        answers = find_answers(sdoc, n)
        s_starts = find_starts(sdoc, [page_lines(p) for p in sdoc], sol_re, n)
        task_imgs = crop_items(tdoc, t_starts, out_dir, "oppg")
        # Mangler et løsningsnummer (f.eks. trykkfeil i PDF-en), får resten ingen løsningsbilde
        sol_imgs = crop_items(sdoc, s_starts, out_dir, "losn") + [[] for _ in range(n - len(s_starts))]

        missing = [i + 1 for i, a in enumerate(answers) if a is None]
        print(f"{set_id}: {n} oppgaver, {len(s_starts)} løsninger, mangler fasit: {missing or '-'}")
        sets.append({
            "id": set_id,
            "level": key,
            "levelName": g["label"],
            "grades": g["grades"],
            "year": year,
            "tasks": [
                {"n": i + 1, "points": points_for(i, n), "answer": answers[i], "img": task_imgs[i], "sol": sol_imgs[i]}
                for i in range(n)
                if answers[i] and task_imgs[i]
            ],
        })

    # Leses inn i databasen av serveren ved oppstart (src/content.ts)
    out = json.dumps({"source": SOURCE, "sets": sets}, ensure_ascii=False, indent=1)
    (OUT_DIR / "sets.json").write_text(out, encoding="utf-8")
    print(f"Skrev {len(sets)} sett til {OUT_DIR / 'sets.json'}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "pdf")
