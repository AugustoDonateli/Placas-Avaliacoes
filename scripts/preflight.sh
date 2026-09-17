#!/usr/bin/env bash
# Conferencia ANTES do deploy.
#
# Existe porque os erros que importam neste projeto sao silenciosos: um
# `workers_dev = true` nao quebra nada visivelmente, so publica uma porta dos
# fundos na API que altera o destino das placas dos clientes. Ninguem percebe
# ate alguem perceber.
#
#   npm run preflight

set -uo pipefail
cd "$(dirname "$0")/.."

FALHAS=0
AVISOS=0

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
falha() { printf '  \033[31m✗\033[0m %s\n' "$1"; FALHAS=$((FALHAS + 1)); }
aviso() { printf '  \033[33m!\033[0m %s\n' "$1"; AVISOS=$((AVISOS + 1)); }
titulo(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
titulo "Segurança"

if grep -qE '^\s*workers_dev\s*=\s*false' wrangler.toml; then
  ok "workers_dev = false — não há rota *.workers.dev contornando o Access"
else
  falha "workers_dev NÃO está false. O Worker ficaria exposto em *.workers.dev, endereço que NÃO passa pelo Cloudflare Access — porta dos fundos direto na API de escrita."
fi

if grep -qE '^\s*ACCESS_TEAM_DOMAIN\s*=\s*"[^"]+"' wrangler.toml \
   && grep -qE '^\s*ACCESS_AUD\s*=\s*"[^"]+"' wrangler.toml; then
  if grep -qE '^\s*ACCESS_AUD\s*=\s*"cole-aqui' wrangler.toml; then
    falha "ACCESS_AUD ainda é o texto de exemplo. Cole a tag Application Audience da aplicação no Access."
  else
    ok "ACCESS_TEAM_DOMAIN e ACCESS_AUD preenchidos"
  fi
else
  falha "ACCESS_TEAM_DOMAIN e/ou ACCESS_AUD ausentes em [vars]. Sem eles a API responde 503 em tudo — não abre, mas também não funciona."
fi

if grep -qE '^\s*ADMIN_EMAILS\s*=\s*"[^"]+"' wrangler.toml; then
  ok "ADMIN_EMAILS preenchido (camada extra sobre a política do Access)"
else
  aviso "ADMIN_EMAILS vazio. Não é obrigatório — o Access já restringe quem recebe token — mas é uma tranca a mais e custa uma linha."
fi

if git check-ignore -q .dev.vars 2>/dev/null; then
  ok ".dev.vars está no .gitignore"
else
  falha ".dev.vars NÃO está no .gitignore. O atalho de desenvolvimento não pode ser versionado."
fi

if grep -rqE '^\s*DEV_INSECURE_API' wrangler.toml 2>/dev/null; then
  falha "DEV_INSECURE_API aparece no wrangler.toml. Esse atalho só pode existir em .dev.vars, que o deploy nunca envia."
else
  ok "DEV_INSECURE_API não está no wrangler.toml"
fi

# ---------------------------------------------------------------------------
titulo "Domínio e banco"

if grep -qE '^\s*routes\s*=' wrangler.toml; then
  if grep -qE 'SEUDOMINIO' wrangler.toml; then
    falha "A rota ainda tem SEUDOMINIO. Troque pelo domínio real."
  else
    ok "Rota do domínio configurada"
  fi
else
  falha "Nenhuma rota configurada. Sem ela o Worker não atende no seu domínio — e é o domínio que está impresso nas placas."
fi

if grep -qE 'database_id\s*=\s*"00000000-0000-0000-0000-000000000000"' wrangler.toml; then
  falha "database_id ainda é o placeholder. Rode: npx wrangler d1 create placas-avaliacoes"
else
  ok "database_id preenchido"
fi

# ---------------------------------------------------------------------------
titulo "Código"

if npm run typecheck --silent > /tmp/preflight-tsc.log 2>&1; then
  ok "typecheck passa"
else
  falha "typecheck falhou — veja /tmp/preflight-tsc.log"
fi

if npx vitest run > /tmp/preflight-test.log 2>&1; then
  ok "$(grep -oE 'Tests +[0-9]+ passed' /tmp/preflight-test.log | tail -1 | tr -s ' ')"
else
  falha "a suíte de testes falhou — veja /tmp/preflight-test.log"
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FALHAS" -gt 0 ]; then
  printf '\033[31m%s problema(s) a resolver antes do deploy.\033[0m\n' "$FALHAS"
  exit 1
fi
if [ "$AVISOS" -gt 0 ]; then
  printf '\033[33mPronto para deploy, com %s aviso(s).\033[0m\n' "$AVISOS"
else
  printf '\033[32mPronto para deploy.\033[0m\n'
fi
printf 'Depois de publicar, rode: npm run smoke SEUDOMINIO.com.br\n'
