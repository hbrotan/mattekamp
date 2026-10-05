-- Grupper (klasse, familie ...) med en kode man deler for å bli med
create table groups (
  id          uniqueidentifier not null primary key default newid(),
  name        nvarchar(40) not null,
  code        varchar(8) not null unique,
  created_at  datetime2 not null default sysutcdatetime()
);

-- Navn er unike per gruppe uten hensyn til store/små bokstaver (CI-kollasjon)
create table players (
  id          uniqueidentifier not null primary key default newid(),
  group_id    uniqueidentifier not null references groups(id) on delete cascade,
  name        nvarchar(30) collate Latin1_General_100_CI_AS not null,
  created_at  datetime2 not null default sysutcdatetime(),
  constraint players_group_name unique (group_id, name)
);

-- Innloggingsøkter; vi lagrer bare SHA-256 av token-en
create table sessions (
  token_hash    char(64) not null primary key,
  player_id     uniqueidentifier not null references players(id) on delete cascade,
  created_at    datetime2 not null default sysutcdatetime(),
  last_seen_at  datetime2 not null default sysutcdatetime()
);
create index sessions_player on sessions (player_id);

-- Oppgavesett fra en kilde (kenguru, senere andre)
create table task_sets (
  id          varchar(100) not null primary key,
  source      varchar(50) not null,
  title       nvarchar(100) not null,
  level       varchar(50) not null,
  level_name  nvarchar(100) not null,
  grades      nvarchar(100) not null default '',
  year        int null,
  sort_key    int not null default 0,
  active      bit not null default 1
);

-- kind: 'choice' (A–E) nå; 'number', 'text' o.l. kan komme senere.
-- prompt/options/solution er JSON.
create table tasks (
  id        varchar(120) not null primary key,
  set_id    varchar(100) not null references task_sets(id) on delete cascade,
  n         int not null,
  kind      varchar(20) not null default 'choice',
  points    int not null,
  prompt    nvarchar(max) not null,
  options   nvarchar(max) null,
  answer    nvarchar(50) not null,
  solution  nvarchar(max) null,
  constraint tasks_set_n unique (set_id, n)
);

create table attempts (
  id               uniqueidentifier not null primary key default newid(),
  player_id        uniqueidentifier not null references players(id) on delete cascade,
  set_id           varchar(100) not null references task_sets(id),
  mode             varchar(10) not null check (mode in ('practice', 'contest')),
  started_at       datetime2 not null default sysutcdatetime(),
  finished_at      datetime2 null,
  elapsed_seconds  int not null default 0,
  points           int not null default 0,
  max_points       int not null,
  correct          int not null default 0,
  total            int not null
);
create index attempts_player on attempts (player_id, finished_at);
create index attempts_set_finished on attempts (set_id) where finished_at is not null;

create table attempt_answers (
  attempt_id   uniqueidentifier not null references attempts(id) on delete cascade,
  task_id      varchar(120) not null references tasks(id),
  answer       nvarchar(50) not null,
  is_correct   bit not null,
  points       int not null,
  answered_at  datetime2 not null default sysutcdatetime(),
  primary key (attempt_id, task_id)
);

-- Hash av sist innlastede content/<kilde>/sets.json, så oppstart kan hoppe over uendret innhold
create table content_versions (
  source     varchar(50) not null primary key,
  hash       char(64) not null,
  loaded_at  datetime2 not null default sysutcdatetime()
);
