#!/usr/bin/env bash
# Bygger imaget i Azure Container Registry og deployer Mattekamp til Azure Container Apps.
#
# Krever: az login, og DATABASE_URL i .env.deploy (eller som miljøvariabel).
# Kenguru-innholdet (content/kenguru) ligger ikke i git; det lastes opp herfra som del av byggekonteksten.
set -euo pipefail
cd "$(dirname "$0")/.."

RG="${RG:-rg-mattekamp}"
LOCATION="${LOCATION:-germanywestcentral}" # nær Neon sin Frankfurt-region

if [ -f .env.deploy ]; then set -a; . ./.env.deploy; set +a; fi
: "${DATABASE_URL:?Sett DATABASE_URL i .env.deploy}"
[ -f content/kenguru/sets.json ] || { echo "content/kenguru mangler – kjør tools/kenguru_extract.py først" >&2; exit 1; }

echo "==> Ressursgruppe $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Register og miljø"
ACR=$(az deployment group create -g "$RG" -n mattekamp-base -f infra/main.bicep \
  -p deployApp=false --query properties.outputs.registryName.value -o tsv)

TAG=$(date +%Y%m%d%H%M%S)
echo "==> Bygger imaget mattekamp:$TAG i $ACR"
az acr build -r "$ACR" -t "mattekamp:$TAG" --no-logs -o none .

echo "==> Deployer appen"
URL=$(az deployment group create -g "$RG" -n mattekamp-app -f infra/main.bicep \
  -p deployApp=true imageTag="$TAG" databaseUrl="$DATABASE_URL" \
  --query properties.outputs.url.value -o tsv)

echo "==> Ferdig: $URL"
