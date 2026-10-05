#!/usr/bin/env bash
# Bygger imaget i Azure Container Registry og deployer Mattekamp til Azure Container Apps (Norway East)
# med en gratis Azure SQL-database på den eksisterende SQL-serveren (North Europe).
#
# Krever: az login som medlem av SQL-serverens Entra-admin-gruppe, og Node (for create-db-user.mjs).
# Abonnementet velges med SUBSCRIPTION (standard «Hallsteins sandbox»).
# Passordet til databasebrukeren genereres første gang og lagres i .env.deploy (ignoreres av git).
# Kenguru-innholdet (content/kenguru) ligger ikke i git; det lastes opp herfra som del av byggekonteksten.
set -euo pipefail
cd "$(dirname "$0")/.."

SUBSCRIPTION="${SUBSCRIPTION:-Hallsteins sandbox}"
RG="${RG:-rg-mattekamp}"
LOCATION="${LOCATION:-norwayeast}"
SQL_SERVER="${SQL_SERVER:-c14p6tdr1x}"
SQL_SERVER_RG="${SQL_SERVER_RG:-Default-SQL-NorthEurope}"

if [ ! -f .env.deploy ]; then
  python -c "
import secrets, string
a = string.ascii_letters + string.digits
while True:
    p = ''.join(secrets.choice(a) for _ in range(32))
    if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
        break
print('SQL_APP_PASSWORD=' + p)" > .env.deploy
  echo "==> Laget nytt databasepassord i .env.deploy – ta vare på filen"
fi
set -a; . ./.env.deploy; set +a
[ -f content/kenguru/sets.json ] || { echo "content/kenguru mangler – kjør tools/kenguru_extract.py først" >&2; exit 1; }

az account set --subscription "$SUBSCRIPTION"
echo "==> Abonnement: $(az account show --query name -o tsv)"

echo "==> Ressursgruppe $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Register, miljø og database"
OUTPUTS=$(az deployment group create -g "$RG" -n mattekamp-base -f infra/main.bicep \
  -p deployApp=false sqlAppPassword="$SQL_APP_PASSWORD" sqlServerName="$SQL_SERVER" sqlServerResourceGroup="$SQL_SERVER_RG" \
  --query "[properties.outputs.registryName.value, properties.outputs.sqlHost.value, properties.outputs.sqlDatabase.value]" -o tsv | tr -d '\r')
ACR=$(sed -n 1p <<< "$OUTPUTS"); SQL_HOST=$(sed -n 2p <<< "$OUTPUTS"); SQL_DATABASE=$(sed -n 3p <<< "$OUTPUTS")
[ -n "$ACR" ] && [ -n "$SQL_HOST" ] && [ -n "$SQL_DATABASE" ] || { echo "Mangler utdata fra deployen: $OUTPUTS" >&2; exit 1; }

echo "==> Databasebruker i $SQL_DATABASE på $SQL_HOST"
MY_IP=$(curl -s https://api.ipify.org)
RULE="mattekamp-deploy"
az sql server firewall-rule create -g "$SQL_SERVER_RG" -s "$SQL_SERVER" -n "$RULE" --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" -o none
trap 'az sql server firewall-rule delete -g "$SQL_SERVER_RG" -s "$SQL_SERVER" -n "$RULE" -o none 2>/dev/null || true' EXIT
SQL_ACCESS_TOKEN=$(az account get-access-token --resource https://database.windows.net/ --query accessToken -o tsv | tr -d '\r') \
  SQL_HOST="$SQL_HOST" SQL_DATABASE="$SQL_DATABASE" node infra/create-db-user.mjs

TAG=$(date +%Y%m%d%H%M%S)
echo "==> Bygger imaget mattekamp:$TAG i $ACR"
az acr build -r "$ACR" -t "mattekamp:$TAG" --no-logs -o none .

echo "==> Deployer appen"
URL=$(az deployment group create -g "$RG" -n mattekamp-app -f infra/main.bicep \
  -p deployApp=true imageTag="$TAG" sqlAppPassword="$SQL_APP_PASSWORD" sqlServerName="$SQL_SERVER" sqlServerResourceGroup="$SQL_SERVER_RG" \
  --query properties.outputs.url.value -o tsv | tr -d '\r')

echo "==> Ferdig: $URL"
