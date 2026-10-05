-- Grupper (klasse, familie ...) med en kode man deler for å bli med
create table groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,
  created_at  timestamptz not null default now()
);

create table players (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references groups(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);
create unique index players_group_name on players (group_id, lower(name));

-- Innloggingsøkter; vi lagrer bare SHA-256 av token-en
create table sessions (
  token_hash    text primary key,
  player_id     uuid not null references players(id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index sessions_player on sessions (player_id);

-- Oppgavesett fra en kilde (kenguru, senere andre)
create table task_sets (
  id          text primary key,
  source      text not null,
  title       text not null,
  level       text not null,
  level_name  text not null,
  grades      text not null default '',
  year        int,
  sort_key    int not null default 0,
  active      boolean not null default true
);

-- kind: 'choice' (A–E) nå; 'number', 'text' o.l. kan komme senere
create table tasks (
  id        text primary key,
  set_id    text not null references task_sets(id) on delete cascade,
  n         int not null,
  kind      text not null default 'choice',
  points    int not null,
  prompt    jsonb not null,
  options   jsonb,
  answer    text not null,
  solution  jsonb,
  unique (set_id, n)
);

create table attempts (
  id               uuid primary key default gen_random_uuid(),
  player_id        uuid not null references players(id) on delete cascade,
  set_id           text not null references task_sets(id),
  mode             text not null check (mode in ('practice', 'contest')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  elapsed_seconds  int not null default 0,
  points           int not null default 0,
  max_points       int not null,
  correct          int not null default 0,
  total            int not null
);
create index attempts_player on attempts (player_id, finished_at);
create index attempts_set_finished on attempts (set_id) where finished_at is not null;

create table attempt_answers (
  attempt_id   uuid not null references attempts(id) on delete cascade,
  task_id      text not null references tasks(id),
  answer       text not null,
  is_correct   boolean not null,
  points       int not null,
  answered_at  timestamptz not null default now(),
  primary key (attempt_id, task_id)
);
