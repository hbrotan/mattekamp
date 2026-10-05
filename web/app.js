(() => {
  "use strict";

  const LEVEL_ORDER = ["preecolier", "ecolier", "duo", "benjamin", "cadet"];
  // Tekster per samling; ukjente samlinger får standardtekstene
  const SOURCE_INFO = {
    kenguru: { desc: "Oppgaver fra Kengurukonkurransen, 1.–10. trinn", levelLabel: "Velg nivå", setLabel: "Velg år" },
    getsmart: { desc: "Videoer fra getsmart.no med oppgaver til hver video, 8.–10. trinn", levelLabel: "Velg område", setLabel: "Velg emne" },
  };
  const sourceInfo = (key) => SOURCE_INFO[key] ?? { desc: "", levelLabel: "Velg nivå", setLabel: "Velg sett" };
  const app = document.getElementById("app");
  const userBox = document.getElementById("user");

  // ---------- Hjelpere ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  };
  const fmtDate = (iso) => new Date(iso).toLocaleDateString("nb-NO", { day: "numeric", month: "short", year: "numeric" });
  const local = {
    get(key, fallback) { try { const v = localStorage.getItem("mh." + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem("mh." + key, JSON.stringify(value)); } catch { /* ignorer */ } },
    remove(key) { try { localStorage.removeItem("mh." + key); } catch { /* ignorer */ } },
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    if (!res.ok) {
      if (res.status === 401 && session) { session = null; renderJoin(); }
      throw new ApiError(res.status, data?.error || "Noe gikk galt");
    }
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }
  const showError = (err) => { if (!(err instanceof ApiError && err.status === 401)) toast(err.message || "Noe gikk galt"); };

  // ---------- Tilstand ----------
  let session = null; // { player, group }
  let sets = [];
  let ui = { source: local.get("source", "kenguru"), level: local.get("level", null), setId: null, mode: local.get("mode", "practice"), boardSet: "" };
  let attempt = null; // pågående forsøk (visning fra serveren)
  let lastResult = null; // sist viste resultat, for gjennomgang av oppgavene
  let current = 0;
  let busy = false;
  let clock = { base: 0, since: Date.now() };
  let timer = null;

  const setById = (id) => sets.find((s) => s.id === id);
  const sources = () => {
    const seen = new Map();
    for (const s of sets) if (!seen.has(s.source)) seen.set(s.source, { key: s.source, name: s.sourceName || s.source });
    // Kenguru først, ellers i rekkefølgen serveren gir
    return [...seen.values()].sort((a, b) => (b.key === "kenguru") - (a.key === "kenguru"));
  };
  const levels = () => {
    const seen = new Map();
    for (const s of sets) if (s.source === ui.source && !seen.has(s.level)) seen.set(s.level, { key: s.level, name: s.levelName, grades: s.grades });
    const list = [...seen.values()];
    return ui.source === "kenguru" ? list.sort((a, b) => LEVEL_ORDER.indexOf(a.key) - LEVEL_ORDER.indexOf(b.key)) : list;
  };

  function renderUser() {
    userBox.innerHTML = session
      ? `<span class="who">${esc(session.player.name)} · ${esc(session.group.name)}</span>
         <button class="link" data-action="board">Toppliste</button>
         <button class="link" data-action="logout">Bytt bruker</button>`
      : "";
  }

  // ---------- Innlogging ----------
  function renderJoin(prefillCode = "") {
    stopTimer();
    attempt = null;
    renderUser();
    app.innerHTML = `
      <h1>Mattekamp</h1>
      <p class="lead">Løs ekte oppgaver fra Kengurukonkurransen og konkurrer med klassen eller familien. Riktig svar gir 3, 4 eller 5 poeng.</p>
      <div class="join">
        <form class="card" id="join-form" autocomplete="off">
          <h2>Bli med i en gruppe</h2>
          <p class="muted">Har du fått en kode fra læreren eller familien? Skriv den inn her.</p>
          <label class="field"><span>Gruppekode</span>
            <input class="name-input code-input" name="code" maxlength="8" required placeholder="F.eks. K7M2QX" value="${esc(prefillCode || local.get("lastCode", ""))}"></label>
          <label class="field"><span>Navnet ditt</span>
            <input class="name-input" name="name" maxlength="30" required placeholder="Fornavn" value="${esc(local.get("lastName", ""))}"></label>
          <button class="btn primary big" type="submit">Bli med</button>
        </form>
        <form class="card" id="create-form" autocomplete="off">
          <h2>Lag en ny gruppe</h2>
          <p class="muted">For en klasse, familie eller vennegjeng. Du får en kode som de andre bruker for å bli med.</p>
          <label class="field"><span>Navn på gruppen</span>
            <input class="name-input" name="groupName" maxlength="40" required placeholder="F.eks. 5B eller Familien Hansen"></label>
          <label class="field"><span>Navnet ditt</span>
            <input class="name-input" name="playerName" maxlength="30" required placeholder="Fornavn"></label>
          <button class="btn big" type="submit">Lag gruppe</button>
        </form>
      </div>`;

    document.getElementById("join-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        session = await api("POST", "/api/session", { code: f.get("code"), name: f.get("name") });
        local.set("lastCode", session.group.code);
        local.set("lastName", session.player.name);
        await enter();
      } catch (err) { showError(err); }
    });
    document.getElementById("create-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        session = await api("POST", "/api/groups", { groupName: f.get("groupName"), playerName: f.get("playerName") });
        local.set("lastCode", session.group.code);
        local.set("lastName", session.player.name);
        await enter(true);
      } catch (err) { showError(err); }
    });
  }

  async function enter(newGroup = false) {
    renderUser();
    sets = await api("GET", "/api/sets");
    if (newGroup) renderGroupCreated();
    else await renderHome();
  }

  function renderGroupCreated() {
    app.innerHTML = `
      <section class="card score-hero">
        <h1>Gruppen «${esc(session.group.name)}» er laget 🎉</h1>
        <p class="muted">Del denne koden med de som skal være med. De skriver den inn sammen med navnet sitt.</p>
        <div class="group-code" aria-label="Gruppekode">${esc(session.group.code)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn" data-action="copy-code">Kopier koden</button>
          <button class="btn primary" data-action="home">Start å løse oppgaver</button>
        </div>
      </section>`;
  }

  // ---------- Startside ----------
  async function renderHome() {
    stopTimer();
    attempt = null;
    const src = sources();
    if (!src.some((x) => x.key === ui.source)) ui.source = src[0]?.key;
    const info = sourceInfo(ui.source);
    const lv = levels();
    if (!ui.level || !lv.some((l) => l.key === ui.level)) ui.level = lv.find((l) => l.key === "ecolier")?.key || lv[0]?.key;
    const levelSets = sets.filter((s) => s.source === ui.source && s.level === ui.level);
    if (levelSets.every((s) => s.year)) levelSets.sort((a, b) => b.year - a.year);
    let step = 0;
    const stepLabel = (text) => `${++step} · ${text}`;
    if (!levelSets.some((s) => s.id === ui.setId)) ui.setId = levelSets[0]?.id;
    let active = [];
    try { active = await api("GET", "/api/attempts/active"); } catch (err) { showError(err); }
    const chosen = setById(ui.setId);

    app.innerHTML = `
      <h1>Hei, ${esc(session.player.name)}!</h1>
      <p class="lead">Velg et oppgavesett. Riktig svar gir 3, 4 eller 5 poeng – jo vanskeligere oppgave, jo flere poeng.
        Gruppekoden for <strong>${esc(session.group.name)}</strong> er <strong class="mono">${esc(session.group.code)}</strong>.</p>

      ${active.map((a) => `
        <div class="resume">
          <div><strong>Påbegynt:</strong> ${esc(a.title)} · ${a.mode === "contest" ? "Konkurranse" : "Øving"}
            <span class="muted">(${a.answered} av ${a.total} besvart)</span></div>
          <span class="spacer"></span>
          <button class="btn" data-action="discard" data-id="${a.id}">Forkast</button>
          <button class="btn primary" data-action="resume" data-id="${a.id}">Fortsett</button>
        </div>`).join("")}

      ${src.length > 1 ? `
        <section class="card">
          <div class="step-label">${stepLabel("Velg samling")}</div>
          <div class="modes">
            ${src.map((x) => `<button class="mode ${x.key === ui.source ? "on" : ""}" data-action="source" data-source="${esc(x.key)}"><strong>${esc(x.name)}</strong><span>${esc(sourceInfo(x.key).desc)}</span></button>`).join("")}
          </div>
        </section>` : ""}

      <section class="card">
        <div class="step-label">${stepLabel(info.levelLabel)}</div>
        <div class="levels">
          ${lv.map((l) => `<button class="level ${l.key === ui.level ? "on" : ""}" data-action="level" data-level="${esc(l.key)}"><strong>${esc(l.name)}</strong><span>${esc(l.grades)}</span></button>`).join("")}
        </div>
        <div class="step-label" style="margin-top:18px">${stepLabel(info.setLabel)}</div>
        <div class="years">
          ${levelSets.map((s) => `<button class="year ${s.year ? "" : "topic"} ${s.id === ui.setId ? "on" : ""}" data-action="set" data-set="${esc(s.id)}">${esc(s.year ?? s.title)}${s.myBest !== null ? `<small>Best: ${s.myBest}/${s.maxPoints}</small>` : ""}</button>`).join("")}
        </div>
      </section>

      <section class="card">
        <div class="step-label">${stepLabel("Hvordan vil du løse?")}</div>
        <div class="modes">
          <button class="mode ${ui.mode === "practice" ? "on" : ""}" data-action="mode" data-mode="practice"><strong>Øving</strong><span>Se med en gang om svaret er riktig, og les løsningsforslaget.</span></button>
          <button class="mode ${ui.mode === "contest" ? "on" : ""}" data-action="mode" data-mode="contest"><strong>Konkurranse</strong><span>Som den ekte konkurransen: svar på alt, få poengene til slutt.</span></button>
        </div>
      </section>

      <button class="btn primary big" data-action="start" ${chosen ? "" : "disabled"}>Start ${chosen ? esc(chosen.title) : ""}</button>`;
    window.scrollTo({ top: 0 });
  }

  async function start() {
    if (!ui.setId || busy) return;
    busy = true;
    try {
      local.set("source", ui.source);
      local.set("level", ui.level);
      local.set("mode", ui.mode);
      openAttempt(await api("POST", "/api/attempts", { setId: ui.setId, mode: ui.mode }));
    } catch (err) { showError(err); } finally { busy = false; }
  }

  function openAttempt(view) {
    if (view.finished) return renderResult(view);
    attempt = view;
    clock = { base: view.elapsedSeconds, since: Date.now() };
    const saved = local.get("pos." + view.id, null);
    current = saved !== null ? saved : Math.max(0, view.tasks.findIndex((t) => !t.answer));
    renderQuiz();
  }

  // ---------- Felles visning av oppgaver ----------
  // Video lastes først ved trykk (raskere side og ingen YouTube-sporing før man velger å se)
  function videoBlock(video) {
    if (!video) return "";
    const id = esc(video.youtubeId);
    return `
      <div class="video" data-yt="${id}">
        <button class="video-start" data-action="play-video" style="background-image:url('https://i.ytimg.com/vi/${id}/hqdefault.jpg')">
          <span class="play" aria-hidden="true">▶</span>
          <span class="video-label"><strong>Se videoen</strong><span>${esc(video.title)}</span></span>
        </button>
      </div>`;
  }

  function promptBlock(task) {
    if (task.text) return `<div class="task text-task"><p class="question">${esc(task.text)}</p></div>`;
    return `<div class="task">${task.images.map((src) => `<img src="${esc(src)}" alt="Oppgave ${task.n}">`).join("")}</div>
      <p class="zoom-hint">Trykk på bildet for å forstørre</p>`;
  }

  function solutionBlock(task) {
    const imgs = task.solution?.length ? `<div class="task">${task.solution.map((src) => `<img src="${esc(src)}" alt="Løsningsforslag til oppgave ${task.n}">`).join("")}</div>` : "";
    const text = task.solutionText ? `<div class="task text-task"><p>${esc(task.solutionText)}</p></div>` : "";
    return imgs + text;
  }

  // Svarknapper: bare bokstaver når alternativene står i bildet, ellers en liste med tekst
  function answerButtons(task, classFor, disabled) {
    if (task.choices) {
      return `<div class="choices" role="group" aria-label="Svaralternativer">
        ${task.options.map((L) => `<button class="choice ${classFor(L)}" data-action="answer" data-l="${esc(L)}" ${disabled ? "disabled" : ""}>
          <span class="key">${esc(L)}</span><span class="choice-text">${esc(task.choices[L] ?? "")}</span></button>`).join("")}
      </div>`;
    }
    return `<div class="answers" role="group" aria-label="Svaralternativer">
      ${task.options.map((L) => `<button class="answer ${classFor(L)}" data-action="answer" data-l="${esc(L)}" ${disabled ? "disabled" : ""}>${esc(L)}</button>`).join("")}
    </div>`;
  }

  // ---------- Oppgaver ----------
  const elapsed = () => clock.base + (document.hidden ? 0 : (Date.now() - clock.since) / 1000);
  let renderedIndex = -1;

  function renderQuiz() {
    const a = attempt;
    const i = current;
    const task = a.tasks[i];
    const practice = a.mode === "practice";
    const locked = practice && !!task.answer;
    const total = a.tasks.length;
    local.set("pos." + a.id, i);

    const dotClass = (t, k) => {
      let c = "dot";
      if (t.answer) c += practice ? (t.isCorrect ? " right" : " wrong") : " answered";
      if (k === i) c += " current";
      return c;
    };
    const answerClass = (L) => {
      if (!locked) return L === task.answer ? "chosen" : "";
      if (L === task.correctAnswer) return "right";
      if (L === task.answer) return "wrong";
      return "";
    };

    const top = `
      <div class="quiz-head">
        <span class="quiz-title">${esc(a.title)}</span>
        <span class="pill">${practice ? "Øving" : "Konkurranse"}</span>
        <span class="spacer"></span>
        ${practice ? `<span class="pill">⭐ ${a.points ?? 0} poeng</span>` : ""}
        <span class="pill" title="Tid brukt">⏱ <span id="clock">${fmtTime(elapsed())}</span></span>
      </div>

      <div class="dots" aria-label="Oppgaver">
        ${a.tasks.map((t, k) => `<button class="${dotClass(t, k)}" data-action="goto" data-i="${k}" aria-label="Oppgave ${t.n}">${t.n}</button>`).join("")}
      </div>`;

    const body = `
      <div class="row" style="margin-bottom:10px">
        <strong>Oppgave ${task.n} av ${total}</strong>
        <span class="pill points">${task.points} poeng</span>
      </div>

      ${promptBlock(task)}
      ${answerButtons(task, answerClass, locked)}

      ${locked ? `
        <div class="feedback ${task.isCorrect ? "right" : "wrong"}">
          ${task.isCorrect ? `Riktig! Du fikk ${task.points} poeng. 🎉` : `Ikke helt. Riktig svar er ${esc(task.correctAnswer)}.`}
        </div>
        ${solutionBlock(task) ? `
          <details class="solution" ${task.isCorrect ? "" : "open"}>
            <summary>Vis løsningsforslag</summary>
            ${solutionBlock(task)}
          </details>` : ""}` : ""}

      <div class="nav">
        <button class="btn" data-action="prev" ${i === 0 ? "disabled" : ""}>← Forrige</button>
        ${i < total - 1 ? `<button class="btn ${task.answer ? "primary" : ""}" data-action="next">${task.answer ? "Neste →" : "Hopp over →"}</button>` : ""}
        <span class="spacer"></span>
        <button class="btn ${i === total - 1 || a.answered === total ? "primary" : ""}" data-action="finish">Lever (${a.answered}/${total} besvart)</button>
      </div>
      <p class="hint hide-sm">Tips: Trykk <kbd>A</kbd>–<kbd>E</kbd> for å svare og <kbd>←</kbd> <kbd>→</kbd> for å bla.</p>`;

    // Samme video som sist: behold videospilleren, så avspillingen ikke starter på nytt
    const yt = task.video?.youtubeId ?? "";
    const videoBox = document.getElementById("quiz-video");
    if (videoBox && videoBox.dataset.attempt === a.id && videoBox.dataset.yt === yt) {
      document.getElementById("quiz-top").innerHTML = top;
      document.getElementById("quiz-body").innerHTML = body;
      if (renderedIndex !== i) document.getElementById("quiz-body").scrollIntoView({ block: "nearest" });
    } else {
      app.innerHTML = `
        <div id="quiz-top">${top}</div>
        <div id="quiz-video" data-attempt="${esc(a.id)}" data-yt="${esc(yt)}">${videoBlock(task.video)}</div>
        <div id="quiz-body">${body}</div>`;
      window.scrollTo({ top: 0 });
    }
    renderedIndex = i;
    startTimer();
  }

  async function answer(letter) {
    const a = attempt;
    const i = current;
    const task = a.tasks[i];
    if (busy || (a.mode === "practice" && task.answer)) return;
    const value = a.mode === "contest" && task.answer === letter ? null : letter;
    busy = true;
    try {
      const res = await api("PUT", `/api/attempts/${a.id}/answers/${task.n}`, { answer: value, elapsedSeconds: Math.round(elapsed()) });
      if (attempt !== a) return;
      a.tasks[i] = res.task;
      a.answered = res.answered;
      a.points = res.points;
      a.correct = res.correct;
      renderQuiz();
      if (a.mode === "contest" && value && i < a.tasks.length - 1) {
        // Kort pause så man ser valget før neste oppgave
        setTimeout(() => { if (attempt === a && current === i) go(i + 1); }, 350);
      }
    } catch (err) { showError(err); } finally { busy = false; }
  }

  function go(i) {
    if (!attempt) return;
    current = Math.max(0, Math.min(attempt.tasks.length - 1, i));
    renderQuiz();
  }

  async function finish() {
    const a = attempt;
    const missing = a.tasks.length - a.answered;
    if (missing > 0 && !confirm(`Du har ${missing} ubesvarte oppgaver. Vil du levere likevel?`)) return;
    if (busy) return;
    busy = true;
    try {
      const result = await api("POST", `/api/attempts/${a.id}/finish`, { elapsedSeconds: Math.round(elapsed()) });
      local.remove("pos." + a.id);
      attempt = null;
      stopTimer();
      const s = setById(result.setId);
      if (s && (s.myBest === null || result.points > s.myBest)) s.myBest = result.points;
      renderResult(result);
    } catch (err) { showError(err); } finally { busy = false; }
  }

  // ---------- Resultat ----------
  function renderResult(result, reviewIndex = null) {
    stopTimer();
    const pct = result.maxPoints ? result.points / result.maxPoints : 0;
    const praise = pct >= 0.9 ? "Fantastisk! 🏆" : pct >= 0.7 ? "Kjempebra! 🌟" : pct >= 0.5 ? "Godt jobbet! 👏" : pct >= 0.25 ? "Bra innsats! 💪" : "Fint at du prøvde! 🦘";
    const t = reviewIndex !== null ? result.tasks[reviewIndex] : null;
    lastResult = result;

    app.innerHTML = `
      <section class="card score-hero">
        <div class="muted">${esc(session.player.name)} · ${esc(result.title)} · ${result.mode === "contest" ? "Konkurranse" : "Øving"}</div>
        <h1 style="margin:10px 0 14px">${praise}</h1>
        <div class="big">${result.points}</div>
        <div class="of">av ${result.maxPoints} mulige poeng</div>
        <div class="stats">
          <div class="stat"><strong>${result.correct}/${result.total}</strong><span>riktige svar</span></div>
          <div class="stat"><strong>${fmtTime(result.elapsedSeconds)}</strong><span>tid brukt</span></div>
          ${result.rank ? `<div class="stat"><strong>#${result.rank}</strong><span>i ${esc(session.group.name)}</span></div>` : ""}
        </div>
        <div class="row" style="justify-content:center;margin-top:22px">
          <button class="btn" data-action="board" data-set="${esc(result.setId)}">Se topplista</button>
          <button class="btn" data-action="retry" data-set="${esc(result.setId)}" data-mode="${result.mode}">Prøv igjen</button>
          <button class="btn primary" data-action="home">Velg nytt sett</button>
        </div>
      </section>

      <section class="card">
        <h2>Gå gjennom oppgavene</h2>
        <div class="review">
          ${result.tasks.map((task, k) => {
            const cls = task.answer ? (task.isCorrect ? "right" : "wrong") : "";
            return `<button class="${cls}" data-action="review" data-i="${k}">
              <strong>${task.n}</strong>${task.answer ? `Ditt svar: ${esc(task.answer)}` : "Ikke besvart"}<br>Riktig: ${esc(task.correctAnswer)}
            </button>`;
          }).join("")}
        </div>
      </section>

      ${t ? `
        <section class="card" id="review-task">
          <div class="row" style="margin-bottom:10px">
            <h2 style="margin:0">Oppgave ${t.n}</h2>
            <span class="pill points">${t.points} poeng</span>
            <span class="spacer"></span>
            <span class="pill">Ditt svar: <strong>${esc(t.answer || "–")}</strong></span>
            <span class="pill">Riktig: <strong>${esc(t.correctAnswer)}</strong></span>
          </div>
          ${videoBlock(t.video)}
          ${promptBlock(t)}
          ${t.choices ? answerButtons(t, (L) => (L === t.correctAnswer ? "right" : L === t.answer ? "wrong" : ""), true) : ""}
          ${solutionBlock(t) ? `<h2>Løsningsforslag</h2>${solutionBlock(t)}` : ""}
        </section>` : ""}`;

    if (t) document.getElementById("review-task").scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0 });
  }

  // ---------- Toppliste ----------
  async function renderBoard() {
    stopTimer();
    if (attempt) { attempt = null; }
    let board, history;
    try {
      [board, history] = await Promise.all([
        api("GET", "/api/leaderboard" + (ui.boardSet ? "?set=" + encodeURIComponent(ui.boardSet) : "")),
        api("GET", "/api/attempts/history"),
      ]);
    } catch (err) { return showError(err); }
    const me = session.player.id;
    const medal = (k) => (k < 3 ? `<span class="medal">${["🥇", "🥈", "🥉"][k]}</span>` : k + 1);

    let body;
    if (!board.rows.length) {
      body = `<p class="empty">Ingen resultater ennå. Løs et sett, så havner du her!</p>`;
    } else if (board.setId) {
      body = `<div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Navn</th><th class="num">Poeng</th><th class="num">Riktige</th><th class="num">Tid</th><th class="hide-sm">Dato</th></tr></thead>
        <tbody>${board.rows.map((r, k) => `<tr class="${r.playerId === me ? "me" : ""}">
          <td>${medal(k)}</td>
          <td>${esc(r.name)}${r.mode === "practice" ? ' <span class="muted">(øving)</span>' : ""}</td>
          <td class="num"><strong>${r.points}</strong>/${r.maxPoints}</td>
          <td class="num">${r.correct}/${r.total}</td>
          <td class="num">${fmtTime(r.elapsedSeconds)}</td>
          <td class="hide-sm">${fmtDate(r.finishedAt)}</td></tr>`).join("")}</tbody></table></div>`;
    } else {
      body = `<p class="muted" style="margin-top:0">Summen av hver persons beste resultat i hvert sett.</p>
        <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Navn</th><th class="num">Poeng totalt</th><th class="num">Sett løst</th><th class="num">Riktige svar</th></tr></thead>
        <tbody>${board.rows.map((r, k) => `<tr class="${r.playerId === me ? "me" : ""}">
          <td>${medal(k)}</td>
          <td>${esc(r.name)}</td>
          <td class="num"><strong>${r.points}</strong></td>
          <td class="num">${r.sets}</td>
          <td class="num">${r.correct}/${r.tasks}</td></tr>`).join("")}</tbody></table></div>`;
    }

    app.innerHTML = `
      <h1>Toppliste – ${esc(session.group.name)}</h1>
      <p class="lead">Alle i gruppen (kode <strong class="mono">${esc(session.group.code)}</strong>) ser den samme topplista.</p>
      <section class="card">
        <div class="board-filters">
          <select id="board-set" aria-label="Velg sett">
            <option value="">Alle sett (totalt)</option>
            ${board.sets.map((s) => `<option value="${esc(s.id)}" ${s.id === board.setId ? "selected" : ""}>${esc(s.title)}</option>`).join("")}
          </select>
        </div>
        ${body}
      </section>
      ${history.length ? `
        <section class="card">
          <h2>Mine resultater</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Sett</th><th class="num">Poeng</th><th class="num">Tid</th><th class="hide-sm">Modus</th><th>Dato</th><th></th></tr></thead>
            <tbody>${history.map((r) => `<tr>
              <td>${esc(r.title)}</td>
              <td class="num"><strong>${r.points}</strong>/${r.maxPoints}</td>
              <td class="num">${fmtTime(r.elapsedSeconds)}</td>
              <td class="hide-sm">${r.mode === "contest" ? "Konkurranse" : "Øving"}</td>
              <td>${fmtDate(r.finishedAt)}</td>
              <td><button class="link" data-action="open-result" data-id="${r.id}">Se</button></td></tr>`).join("")}</tbody>
          </table></div>
        </section>` : ""}`;

    document.getElementById("board-set").addEventListener("change", (e) => { ui.boardSet = e.target.value; renderBoard(); });
    window.scrollTo({ top: 0 });
  }

  // ---------- Klokke ----------
  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      const el = document.getElementById("clock");
      if (el && attempt) el.textContent = fmtTime(elapsed());
    }, 1000);
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  document.addEventListener("visibilitychange", () => {
    // Tiden teller bare mens siden er synlig
    if (document.hidden) clock = { base: clock.base + (Date.now() - clock.since) / 1000, since: Date.now() };
    else clock.since = Date.now();
  });

  // Bildene er rendret i dobbel oppløsning; vis dem i litt over naturlig PDF-størrelse.
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.closest(".task")) img.style.width = Math.round(img.naturalWidth * 0.65) + "px";
  }, true);

  // ---------- Hendelser ----------
  // Trykk på et oppgavebilde veksler mellom tilpasset bredde og full størrelse
  document.addEventListener("click", (e) => {
    const img = e.target.closest(".task img");
    if (!img) return;
    const box = img.closest(".task");
    box.classList.toggle("zoomed");
    for (const i of box.querySelectorAll("img")) {
      i.style.width = box.classList.contains("zoomed") ? Math.round(i.naturalWidth * 0.85) + "px" : Math.round(i.naturalWidth * 0.65) + "px";
    }
  });

  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || !session && !["home"].includes(el.dataset.action)) return;
    const d = el.dataset;
    try {
      switch (d.action) {
        case "home": e.preventDefault(); if (session) await renderHome(); else renderJoin(); break;
        case "board": ui.boardSet = d.set || ""; await renderBoard(); break;
        case "logout":
          await api("DELETE", "/api/session");
          session = null;
          renderJoin();
          break;
        case "copy-code":
          try { await navigator.clipboard.writeText(session.group.code); toast("Koden er kopiert"); } catch { toast("Koden er " + session.group.code); }
          break;
        case "source": ui.source = d.source; ui.level = null; ui.setId = null; await renderHome(); break;
        case "level": ui.level = d.level; ui.setId = null; await renderHome(); break;
        case "set": ui.setId = d.set; await renderHome(); break;
        case "mode": ui.mode = d.mode; await renderHome(); break;
        case "start": await start(); break;
        case "resume": openAttempt(await api("GET", `/api/attempts/${d.id}`)); break;
        case "discard":
          if (confirm("Vil du forkaste det påbegynte forsøket?")) {
            await api("DELETE", `/api/attempts/${d.id}`);
            local.remove("pos." + d.id);
            await renderHome();
          }
          break;
        case "answer": await answer(d.l); break;
        case "play-video": {
          const box = el.closest(".video");
          const id = encodeURIComponent(box.dataset.yt);
          box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1"
            title="Video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
          break;
        }
        case "goto": go(+d.i); break;
        case "prev": go(current - 1); break;
        case "next": go(current + 1); break;
        case "finish": await finish(); break;
        case "retry": {
          const s = setById(d.set);
          if (s) { ui.setId = s.id; ui.source = s.source; ui.level = s.level; ui.mode = d.mode || ui.mode; await start(); }
          break;
        }
        case "review": if (lastResult) renderResult(lastResult, +d.i); break;
        case "open-result": renderResult(await api("GET", `/api/attempts/${d.id}`)); break;
      }
    } catch (err) { showError(err); }
  });

  document.addEventListener("keydown", (e) => {
    if (!attempt || !document.querySelector(".answers, .choices")) return;
    if (e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toUpperCase();
    if (attempt.tasks[current].options.includes(k)) { e.preventDefault(); answer(k); }
    else if (e.key === "ArrowRight") go(current + 1);
    else if (e.key === "ArrowLeft") go(current - 1);
  });

  // ---------- Oppstart ----------
  (async () => {
    // Lenke med kode (?kode=XXXXXX) fyller inn gruppekoden
    const codeFromUrl = new URLSearchParams(location.search).get("kode") || "";
    try {
      session = await api("GET", "/api/session");
      await enter();
    } catch {
      renderJoin(codeFromUrl);
    }
  })();
})();
