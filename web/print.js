(() => {
  "use strict";

  const sheet = document.getElementById("sheet");
  const optFasit = document.getElementById("opt-fasit");
  const optLosning = document.getElementById("opt-losning");
  const printBtn = document.getElementById("print-btn");
  const params = new URLSearchParams(location.search);
  const setId = params.get("set");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const status = (html) => { sheet.innerHTML = `<p class="status">${html}</p>`; };

  optFasit.checked = params.get("fasit") === "1";
  optLosning.checked = params.get("losning") === "1";
  optLosning.disabled = !optFasit.checked;

  // Bildene er rendret i dobbel oppløsning: halv bredde gir omtrent original PDF-størrelse på A4
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.dataset.scale) img.style.width = Math.round(img.naturalWidth * Number(img.dataset.scale)) + "px";
  }, true);

  const withUnit = (v, t) => `${v}${t.unit ? ` ${t.unit}` : ""}`;
  const tableHtml = (table) => !table ? "" : table.chart === "bar" && !table.showTable ? `<div class="chart">${window.barChartSvg(table)}</div>`
    : `${table.chart === "bar" ? `<div class="chart">${window.barChartSvg(table)}</div>` : ""}<table class="data-table">
    <thead><tr>${table.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  function taskHtml(t) {
    const head = `<div class="task-head"><strong>Oppgave ${t.n}</strong><span class="points">${t.points} poeng</span></div>`;
    if (t.text) {
      const video = t.video
        ? `<p class="video-ref">Video: ${esc(t.video.title)} · <span class="url">youtu.be/${esc(t.video.youtubeId)}</span></p>`
        : "";
      const answer = t.options
        ? `<ol class="choices">${t.options.map((L) => `<li><span class="key">${esc(L)}</span>${esc(t.choices?.[L] ?? "")}</li>`).join("")}</ol>`
        : `<p class="answer-line">Svar: <span class="blank answer-blank"></span>${t.unit ? ` ${esc(t.unit)}` : ""}</p>`;
      return `<section class="task">${head}
        <p class="question">${esc(t.text)}</p>
        ${tableHtml(t.table)}
        ${answer}
        ${video}
      </section>`;
    }
    return `<section class="task">${head}
      ${t.images.map((src) => `<img src="${esc(src)}" data-scale="0.5" alt="Oppgave ${t.n}">`).join("")}
      <p class="answer-line">Svar: ${t.options.map((L) => `<span class="circle">${esc(L)}</span>`).join("")}</p>
    </section>`;
  }

  function fasitHtml(set, withSolutions) {
    const rows = set.tasks.map((t) => `<tr><td>${t.n}</td><td><strong>${esc(withUnit(t.correctAnswer, t))}</strong>${t.choices ? ` – ${esc(t.choices[t.correctAnswer] ?? "")}` : ""}</td><td>${t.points}</td></tr>`).join("");
    const solutions = withSolutions
      ? set.tasks.filter((t) => t.solutionText || t.solution?.length).map((t) => `
          <section class="task solution">
            <div class="task-head"><strong>Oppgave ${t.n}</strong><span class="points">Svar: ${esc(withUnit(t.correctAnswer, t))}</span></div>
            ${t.solutionText ? `<p>${esc(t.solutionText)}</p>` : ""}
            ${(t.solution ?? []).map((src) => `<img src="${esc(src)}" data-scale="0.5" alt="Løsningsforslag ${t.n}">`).join("")}
          </section>`).join("")
      : "";
    return `
      <div class="fasit">
        <h2>Fasit – ${esc(set.title)}</h2>
        <table><thead><tr><th>Oppgave</th><th>Riktig svar</th><th>Poeng</th></tr></thead><tbody>${rows}</tbody></table>
        ${solutions ? `<h2 class="solutions-title">Løsningsforslag</h2>${solutions}` : ""}
      </div>`;
  }

  async function load() {
    if (!setId) return status("Mangler oppgavesett. Gå tilbake og velg et sett.");
    printBtn.disabled = true;
    const withFasit = optFasit.checked;
    const res = await fetch(`/api/sets/${encodeURIComponent(setId)}/print${withFasit ? "?fasit=1" : ""}`, { credentials: "same-origin" });
    if (res.status === 401) return status(`Du må være logget inn. <a href="/">Gå til Mattekamp</a> og bli med i en gruppe først.`);
    if (!res.ok) return status("Fant ikke oppgavesettet.");
    const set = await res.json();
    document.title = `${set.title} – Mattekamp`;
    sheet.innerHTML = `
      <header class="sheet-head">
        <div>
          <div class="source">${esc(set.sourceName)} · ${esc(set.levelName)}${set.grades ? ` · ${esc(set.grades)}` : ""}</div>
          <h1>${esc(set.title)}</h1>
          <p class="rules">${set.tasks.length} oppgaver · riktig svar gir 3, 4 eller 5 poeng · maks ${set.maxPoints} poeng. Ring rundt eller skriv ett svar per oppgave.</p>
        </div>
        <div class="fields">
          <div>Navn: <span class="blank"></span></div>
          <div>Gruppe/klasse: <span class="blank"></span></div>
          <div>Dato: <span class="blank short"></span> Poeng: <span class="blank short"></span></div>
        </div>
      </header>
      <div class="tasks">${set.tasks.map(taskHtml).join("")}</div>
      ${withFasit ? fasitHtml(set, optLosning.checked) : ""}
      <footer class="sheet-foot">${set.source === "kenguru"
        ? "Oppgavene er fra Kengurukonkurransen (Matematikksenteret)."
        : set.source === "getsmart" ? "Videoene er fra getsmart.no. Oppgavene er laget for Mattekamp."
        : set.source === "nasjonale-prover" ? "Øvingsoppgaver laget for Mattekamp i stil med nasjonale prøver i regning (ikke Udirs prøver)." : ""}</footer>`;
    printBtn.disabled = false;
  }

  function syncUrl() {
    const p = new URLSearchParams({ set: setId });
    if (optFasit.checked) p.set("fasit", "1");
    if (optFasit.checked && optLosning.checked) p.set("losning", "1");
    history.replaceState(null, "", `?${p}`);
  }

  optFasit.addEventListener("change", () => { optLosning.disabled = !optFasit.checked; if (!optFasit.checked) optLosning.checked = false; syncUrl(); load(); });
  optLosning.addEventListener("change", () => { syncUrl(); load(); });
  printBtn.addEventListener("click", () => window.print());

  load().catch(() => status("Noe gikk galt. Prøv å laste siden på nytt."));
})();
