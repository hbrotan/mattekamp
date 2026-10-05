"""Henter videokatalogen fra getsmart.no (åpne sider, ingen innlogging).

Lagrer emner og videoer (kode, tittel, YouTube-id, varighet, beskrivelse) i
content/getsmart/catalog.json. Katalogen brukes som grunnlag når vi skriver egne
oppgaver til videoene; den publiseres ikke selv (se .gitignore).

GetSmart oppgir at videoene er gratis og åpent tilgjengelige. Oppgavene og fasiten
som ligger bak tilgangsnøkler er betalt innhold og hentes IKKE.

Bruk:
    python tools/getsmart_fetch.py
"""
import html
import json
import re
import time
import urllib.request
from pathlib import Path

BASE = "https://www.getsmart.no"
OUT = Path(__file__).resolve().parent.parent / "content" / "getsmart" / "catalog.json"


def get(path: str) -> str:
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "mattekamp-katalog/1.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8")


def text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def topics() -> list[tuple[str, str]]:
    page = get("/no/videos")
    seen, out = set(), []
    for slug, name in re.findall(r'href="/no/videos/topic/([a-z0-9_-]+)"[^>]*>(.*?)</a>', page, re.S):
        if slug not in seen:
            seen.add(slug)
            out.append((slug, text(name)))
    return out


def videos(slug: str) -> list[dict]:
    page = get(f"/no/videos/topic/{slug}")
    out = []
    # Hver video: <a href=".../view_video/KODE"><img ... src=".../vi/YOUTUBEID/..."></a> <div class="info"> ... </div>
    for block in re.split(r'(?=<a href="/no/videos/view_video/\d+"><img)', page)[1:]:
        code = re.search(r"view_video/(\d+)", block).group(1)
        yt = re.search(r"i\.ytimg\.com/vi/([A-Za-z0-9_-]{6,})/", block)
        title = re.search(r"<h3>(.*?)</h3>", block, re.S)
        desc = re.search(r"<p>(.*?)</p>", block, re.S)
        data = re.search(r'<div class="video_data">(.*?)</div>', block, re.S)
        duration = re.search(r"(\d+:\d\d)", text(data.group(1))) if data else None
        if not yt or not title:
            continue
        out.append({
            "code": code,
            "title": re.sub(r"^α?\d+:\s*", "", text(title.group(1))),
            "youtubeId": yt.group(1),
            "duration": duration.group(1) if duration else None,
            "description": text(desc.group(1)) if desc else "",
        })
    return out


def main():
    catalog = []
    for slug, name in topics():
        vids = videos(slug)
        print(f"{name}: {len(vids)} videoer")
        catalog.append({"slug": slug, "name": name, "videos": vids})
        time.sleep(0.5)  # skånsomt mot nettstedet
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Skrev {sum(len(t['videos']) for t in catalog)} videoer i {len(catalog)} emner til {OUT}")


if __name__ == "__main__":
    main()
