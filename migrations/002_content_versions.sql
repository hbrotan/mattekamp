-- Hash av sist innlastede content/<kilde>/sets.json, så oppstart kan hoppe over uendret innhold
create table content_versions (
  source     text primary key,
  hash       text not null,
  loaded_at  timestamptz not null default now()
);
