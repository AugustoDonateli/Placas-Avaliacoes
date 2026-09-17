#!/usr/bin/env bash
# Conferencia DEPOIS do deploy, contra o ambiente que esta no ar.
#
# Deploy que sobe sem erro nao significa deploy correto. Este script confere as
# quatro coisas que, se estiverem erradas, quebram o produto sem dar sinal:
#
#   1. o redirecionamento responde 302 e nao 301 (301 e irreversivel);
#   2. a resposta nao pode ser cacheada;
#   3. a API esta protegida de verdade;
#   4. nao existe uma copia do Worker em *.workers.dev sem protecao.
#
#   npm run smoke SEUDOMINIO.com.br [codigo-de-uma-placa-ativa] [subdominio-workers-dev]
#
# Exemplo:
#   npm run smoke avalia.com.br 001 placas-avaliacoes.minhaconta.workers.dev

set -uo pipefail

HOST="${1:-}"
CODIGO="${2:-001}"
WORKERS_DEV="${3:-}"

if [ -z "$HOST" ]; then
  echo "uso: $0 <dominio> [codigo-de-placa-ativa] [host.workers.dev]" >&2
  exit 2
fi

# Aceita "avalia.com.br" ou uma URL completa — a segunda forma permite apontar
# para o servidor local e conferir o proprio script.
case "$HOST" in
  http://*|https://*) BASE="$HOST" ;;
  *)                  BASE="https://${HOST}" ;;
esac
FALHAS=0

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
falha() { printf '  \033[31m✗\033[0m %s\n' "$1"; FALHAS=$((FALHAS + 1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$1"; }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# Devolve "status|cabecalhos" sem seguir redirecionamento.
fetch() {
  curl -s -i --max-time 15 "$1" 2>/dev/null
}
status_of() { printf '%s' "$1" | head -1 | awk '{print $2}'; }
header_of() {
  printf '%s' "$1" | grep -i "^$2:" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'
}

# ---------------------------------------------------------------------------
titulo "Redirecionamento — /${CODIGO}"

RESP="$(fetch "${BASE}/${CODIGO}")"
STATUS="$(status_of "$RESP")"
LOCATION="$(header_of "$RESP" 'location')"
CACHE="$(header_of "$RESP" 'cache-control')"

case "$STATUS" in
  302)
    ok "responde 302"
    ;;
  301|308)
    falha "responde $STATUS — PERMANENTE. Navegador cacheia para sempre e não respeita invalidação. Esta placa não poderá mais ser reatribuída. Corrija e republique ANTES de imprimir qualquer QR."
    ;;
  200)
    aviso "responde 200 — a placa /${CODIGO} existe mas não está ativa. Passe o código de uma placa ativa como segundo argumento."
    ;;
  *)
    falha "responde $STATUS — esperado 302"
    ;;
esac

if [ -n "$LOCATION" ]; then
  case "$LOCATION" in
    https://g.page/*|https://search.google.com/*|https://maps.app.goo.gl/*|https://goo.gl/maps/*|https://*.google.com/*|https://google.com/*|https://*.google.com.br/*|https://google.com.br/*)
      ok "Location aponta para o Google: $LOCATION"
      ;;
    *)
      falha "Location aponta para FORA do Google: $LOCATION"
      ;;
  esac
fi

case "$CACHE" in
  *no-store*) ok "Cache-Control: $CACHE" ;;
  "")         [ "$STATUS" = "302" ] && falha "sem Cache-Control — a troca de destino pode não refletir" ;;
  *)          falha "Cache-Control: $CACHE — precisa conter no-store" ;;
esac

# ---------------------------------------------------------------------------
titulo "Páginas de estado"

RESP="$(fetch "${BASE}/zzzz9999")"
if [ "$(status_of "$RESP")" = "404" ]; then
  ok "código inexistente responde 404"
else
  falha "código inexistente responde $(status_of "$RESP") — esperado 404"
fi

RESP="$(fetch "${BASE}/")"
if [ "$(status_of "$RESP")" = "200" ]; then
  ok "raiz responde 200"
else
  falha "raiz responde $(status_of "$RESP")"
fi

# ---------------------------------------------------------------------------
titulo "API administrativa"

for ROTA in "/api/plates" "/api/plates/${CODIGO}"; do
  RESP="$(fetch "${BASE}${ROTA}")"
  STATUS="$(status_of "$RESP")"
  case "$STATUS" in
    200)
      falha "$ROTA responde 200 SEM autenticação. A API de escrita está aberta ao mundo."
      ;;
    401|403)
      ok "$ROTA exige autenticação ($STATUS)"
      ;;
    302|303)
      # O Access redireciona o navegador para a tela de login.
      ok "$ROTA redireciona para o login do Access ($STATUS)"
      ;;
    503)
      falha "$ROTA responde 503 — ACCESS_TEAM_DOMAIN/ACCESS_AUD não chegaram ao Worker. A API está fechada, mas você também não consegue usá-la."
      ;;
    *)
      falha "$ROTA responde $STATUS — esperado 401, 403 ou redirecionamento do Access"
      ;;
  esac
done

# Escrita sem token nunca pode passar.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST "${BASE}/api/plates" -H 'content-type: application/json' \
  -d '{"from":"900","to":"901"}' 2>/dev/null)"
if [ "$STATUS" = "201" ] || [ "$STATUS" = "200" ]; then
  falha "POST /api/plates SEM token respondeu $STATUS — criou placas. Isto é crítico."
else
  ok "POST sem token é recusado ($STATUS)"
fi

# ---------------------------------------------------------------------------
titulo "Porta dos fundos em *.workers.dev"

if [ -n "$WORKERS_DEV" ]; then
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    "https://${WORKERS_DEV}/api/plates" 2>/dev/null)"
  if [ "$STATUS" = "000" ]; then
    ok "${WORKERS_DEV} não resolve — a rota não existe"
  elif [ "$STATUS" = "404" ] || [ "$STATUS" = "530" ]; then
    ok "${WORKERS_DEV} não serve o Worker ($STATUS)"
  elif [ "$STATUS" = "200" ]; then
    falha "${WORKERS_DEV}/api/plates respondeu 200. O Access NÃO cobre *.workers.dev: a API está aberta por esse endereço. Ponha workers_dev = false e republique."
  else
    aviso "${WORKERS_DEV}/api/plates respondeu $STATUS — confira manualmente"
  fi
else
  aviso "subdomínio workers.dev não informado; passe como terceiro argumento para conferir a porta dos fundos"
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FALHAS" -gt 0 ]; then
  printf '\033[31m%s problema(s) no ambiente publicado.\033[0m\n' "$FALHAS"
  exit 1
fi
printf '\033[32mAmbiente publicado conferido.\033[0m\n'
