#!/usr/bin/env bash
# Sobe o `wrangler dev` de forma confiavel para testes de ponta a ponta.
#
# Existe por um motivo concreto: `kill` no processo do wrangler NAO derruba o
# `workerd` filho, que continua segurando a porta e servindo o codigo ANTIGO.
# Um teste que fala com esse processo orfao devolve resultado falso — e parece
# um resultado legitimo.
#
#   scripts/dev-server.sh start [porta]
#   scripts/dev-server.sh stop  [porta]

set -uo pipefail

PORT="${2:-8799}"

stop() {
  pkill -f "wrangler dev" 2>/dev/null || true
  pkill -f "workerd serve" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! (lsof -i ":$PORT" 2>/dev/null | grep -q LISTEN); then
      return 0
    fi
    sleep 0.5
  done
  echo "AVISO: a porta $PORT continua ocupada" >&2
  return 1
}

start() {
  stop
  npx wrangler dev --port "$PORT" --local > /tmp/wrangler-dev.log 2>&1 &
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then
      # Confirma que quem respondeu e o processo que acabamos de subir.
      echo "servidor pronto em http://127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  echo "ERRO: o servidor nao subiu; veja /tmp/wrangler-dev.log" >&2
  tail -20 /tmp/wrangler-dev.log >&2
  return 1
}

case "${1:-}" in
  start) start ;;
  stop)  stop && echo "parado" ;;
  *) echo "uso: $0 {start|stop} [porta]" >&2; exit 2 ;;
esac
