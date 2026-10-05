#!/usr/bin/env bash
# Bygger imaget i Azure Container Registry og deployer Mattekamp til Azure Container Apps
# med gratis Azure SQL, alt i Norway East.
#
# Krever: az login (abonnementet velges med SUBSCRIPTION, standard «Hallsteins sandbox»).
# SQL-passordet genereres første gang og lagres i .env.deploy (ignoreres av git) – ta vare på filen.
# Kenguru-innholdet (content/kenguru) ligger ikke i git; det lastes opp herfra som del av byggekonteksten.
set -euo pipefail
cd "$(dirname "$0")/.."

SUBSCRIPTION="${SUBSCRIPTION:-Hallsteins sandbox}"
RG="${RG:-rg-mattekamp}"
LOCATION="${LOCATION:-norwayeast}"

if [ ! -f .env.deploy ]; then
  # Store og små bokstaver + tall, slik Azure SQL krever; ingen tegn som må escapes i tilkoblingsstrengen
  python -c "
import secrets, string
a = string.ascii_letters + string.digits
while True:
    p = ''.join(secrets.choice(a) for _ in range(32))
    if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
        break
print('SQL_ADMIN_PASSWORD=' + p)" > .env.deploy
  echo "==> Laget nytt SQL-passord i .env.deploy – ta vare på filen"
fi
set -a; . ./.env.deploy; set +a
[ -f content/kenguru/sets.json ] || { echo "content/kenguru mangler – kjør tools/kenguru_extract.py først" >&2; exit 1; }

az account set --subscription "$SUBSCRIPTION"
echo "==> Abonnement: $(az account show --query name -o tsv)"

echo "==> Ressursgruppe $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Register, database og miljø"
ACR=$(az deployment group create -g "$RG" -n mattekamp-base -f infra/main.bicep \
  -p deployApp=false sqlAdminPassword="$SQL_ADMIN_PASSWORD" \
  --query properties.outputs.registryName.value -o tsv)

TAG=$(date +%Y%m%d%H%M%S)
echo "==> Bygger imaget mattekamp:$TAG i $ACR"
az acr build -r "$ACR" -t "mattekamp:$TAG" --no-logs -o none .

echo "==> Deployer appen"
URL=$(az deployment group create -g "$RG" -n mattekamp-app -f infra/main.bicep \
  -p deployApp=true imageTag="$TAG" sqlAdminPassword="$SQL_ADMIN_PASSWORD" \
  --query properties.outputs.url.value -o tsv)

echo "==> Ferdig: $URL"
