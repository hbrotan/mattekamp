# Mattekamp

Nettside for å løse oppgaver fra Kengurukonkurransen, med felles toppliste per gruppe
(klasse, familie ...). Man lager eller blir med i en gruppe med en kode, skriver navnet sitt,
og får 3, 4 eller 5 poeng per riktig svar. Rettingen skjer på serveren, så fasiten sendes
ikke til nettleseren før oppgaven er besvart (øving) eller levert (konkurranse).

## Arkitektur

| Del | Hva |
| --- | --- |
| `src/` | API i TypeScript (Hono på Node 22) |
| `migrations/` | Databaseskjema i T-SQL (kjøres automatisk ved oppstart; batcher skilles med `GO`) |
| `content/<kilde>/` | Oppgaveinnhold: `sets.json` + bilder. Lastes inn i databasen ved oppstart |
| `web/` | Frontend (ren HTML/CSS/JS, ingen byggesteg) |
| `tools/` | Skript som lager innhold, f.eks. `kenguru_extract.py` |
| `infra/` | Bicep og deployskript for Azure |
| `test/` | Integrasjonstester mot ekte SQL Server |

Databasen har `groups`, `players`, `sessions`, `task_sets`, `tasks`, `attempts` og
`attempt_answers`. Oppgaver har en `kind` (nå bare `choice`), og rettingen ligger i
`src/grading.ts`, slik at nye oppgavetyper (tallsvar, tekst ...) kan legges til der.

## Kjøre lokalt

Krever Node 22+ og Docker. Databasen er SQL Server 2022 i Docker (samme motor som Azure SQL).

```bash
npm install
cp .env.example .env
npm run db:up
npm run dev
```

Åpne <http://localhost:3000>.

Hele appen i Docker (app + database):

```bash
docker compose --profile app up --build
```

## Tester

```bash
npm run db:up
npm test
```

Testene bruker en egen database, `mattekamp_test`, og tømmer den før hver kjøring.

## Legge til nye oppgaver

Lag `content/<kilde>/sets.json` med bilder ved siden av:

```json
{
  "source": "min-kilde",
  "sets": [{
    "id": "sett-1", "level": "ecolier", "levelName": "Ecolier", "grades": "4.–5. trinn", "year": 2026,
    "tasks": [{ "n": 1, "points": 3, "answer": "B", "img": ["min-kilde/sett-1/oppg01.png"], "sol": [] }]
  }]
}
```

Serveren laster innholdet inn i databasen neste gang den starter.

Kenguru-innholdet er opphavsrettslig beskyttet og ligger derfor **ikke** i dette repoet
(`content/kenguru/` er i `.gitignore`). Det lages lokalt fra PDF-ene i
[Matematikksenterets oppgavebank](https://www.matematikksenteret.no/l%C3%A6ringsressurser/kenguru/kenguruoppgaver-oppgavebank):

```bash
pip install pymupdf pillow
python tools/kenguru_extract.py <mappe-med-pdf-er>
```

## Deploy (Azure Container Apps + Azure SQL, Norway East)

Appen kjører på Azure Container Apps, og databasen er en gratis Azure SQL-database
(serverless «free offer»). Infrastrukturen er i `infra/` (Bicep).

- Container Apps skalerer til null når ingen bruker siden. Første besøk etter en pause tar noen sekunder.
- Databasen pauser etter én time uten bruk og bruker opptil ca. ett minutt på å våkne; appen venter og prøver igjen.
- Gratiskvoten er 100 000 vCore-sekunder og 32 GB per måned. Brukes den opp, pauses databasen ut
  måneden i stedet for å koste penger (`freeLimitExhaustionBehavior: AutoPause` i `infra/sql.bicep`).
- Containerregisteret (Basic) koster ca. 50 kr/mnd; resten er gratis ved lav bruk.

Sørg for at `content/kenguru/` finnes lokalt (se over), logg inn med `az login`, og kjør:

```bash
bash infra/deploy.sh
```

Skriptet bruker abonnementet «Hallsteins sandbox» (overstyr med `SUBSCRIPTION=...`), lager
ressursgruppen `rg-mattekamp`, genererer et SQL-passord i `.env.deploy` første gang (ignoreres av
git – ta vare på filen), bygger imaget i Azure Container Registry og deployer en ny versjon.
Kjør det på nytt for å deploye endringer.

## Miljøvariabler

| Variabel | Standard | |
| --- | --- | --- |
| `DATABASE_URL` | – | SQL Server-tilkoblingsstreng (påkrevd), f.eks. `Server=...;Database=...;User Id=...;Password=...;Encrypt=true` |
| `DB_AUTO_CREATE` | `false` | Lag databasen hvis den mangler (lokalt) |
| `PORT` | `3000` | |
| `SECURE_COOKIES` | `true` i produksjon | Sett `false` lokalt uten HTTPS |
