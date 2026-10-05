// Oppretter (eller oppdaterer passordet til) databasebrukeren mattekamp_app i Mattekamp-databasen.
// Kjøres av deploy.sh med et Entra-token for en administrator på SQL-serveren.
// Brukeren er «contained»: den finnes bare i denne databasen og har ingen tilgang til andre databaser.
//
// Miljø: SQL_HOST, SQL_DATABASE, SQL_ACCESS_TOKEN, SQL_APP_PASSWORD
import mssql from "mssql";

const { SQL_HOST, SQL_DATABASE, SQL_ACCESS_TOKEN, SQL_APP_PASSWORD } = process.env;
if (!SQL_HOST || !SQL_DATABASE || !SQL_ACCESS_TOKEN || !SQL_APP_PASSWORD) {
  throw new Error("Mangler SQL_HOST, SQL_DATABASE, SQL_ACCESS_TOKEN eller SQL_APP_PASSWORD");
}
// CREATE USER ... WITH PASSWORD tar ikke parametre; passordet er generert og kun bokstaver/tall
if (!/^[A-Za-z0-9]{24,}$/.test(SQL_APP_PASSWORD)) throw new Error("Uventet passordformat");

const pool = new mssql.ConnectionPool({
  server: SQL_HOST,
  database: SQL_DATABASE,
  authentication: { type: "azure-active-directory-access-token", options: { token: SQL_ACCESS_TOKEN } },
  options: { encrypt: true },
  connectionTimeout: 90_000,
  requestTimeout: 60_000,
});

for (let attempt = 1; ; attempt++) {
  try {
    await pool.connect();
    break;
  } catch (err) {
    // Gratisdatabasen kan være pauset og bruker litt tid på å våkne
    if (attempt >= 10) throw err;
    console.log(`Venter på databasen (${err.message}) ...`);
    await new Promise((r) => setTimeout(r, 6000));
  }
}

await pool.request().batch(`
  if not exists (select 1 from sys.database_principals where name = 'mattekamp_app')
    create user [mattekamp_app] with password = '${SQL_APP_PASSWORD}';
  else
    alter user [mattekamp_app] with password = '${SQL_APP_PASSWORD}';
  alter role db_owner add member [mattekamp_app];
`);
await pool.close();
console.log("Databasebrukeren mattekamp_app er klar");
