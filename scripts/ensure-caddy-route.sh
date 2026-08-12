#!/usr/bin/env bash
set -u

project_dir="/home/admin/DungenBlitz"
source_caddyfile="/etc/caddy/Caddyfile"
runtime_caddyfile="${project_dir}/deploy/Caddyfile.runtime"
target_host="dungenblitz.ecliptia.net"

route_exists() {
  curl -fsS http://127.0.0.1:2019/config/apps/http/servers/srv0/routes 2>/dev/null |
    python3 -c '
import json
import sys

target = "dungenblitz.ecliptia.net"
for route in json.load(sys.stdin):
    for matcher in route.get("match", []):
        if target in matcher.get("host", []):
            raise SystemExit(0)
raise SystemExit(1)
' >/dev/null 2>&1
}

install_route() {
  [[ -r "${source_caddyfile}" ]] || return 1

  local temporary
  temporary="$(mktemp "${runtime_caddyfile}.XXXXXX")" || return 1
  chmod 600 "${temporary}"

  cat "${source_caddyfile}" > "${temporary}"
  cat >> "${temporary}" <<EOF

${target_host} {
    handle /game-socket {
        reverse_proxy 127.0.0.1:8090
    }

    handle {
        reverse_proxy 127.0.0.1:8001
    }
}
EOF

  if caddy validate --config "${temporary}" --adapter caddyfile >/dev/null 2>&1 &&
     caddy reload --config "${temporary}" --adapter caddyfile >/dev/null 2>&1; then
    mv "${temporary}" "${runtime_caddyfile}"
    chmod 600 "${runtime_caddyfile}"
    printf '[caddy-sync] Restored %s from the current system Caddyfile.\n' "${target_host}"
    return 0
  fi

  python3 - "${temporary}" <<'PY'
from pathlib import Path
import sys

Path(sys.argv[1]).unlink(missing_ok=True)
PY
  return 1
}

while true; do
  if ! route_exists; then
    install_route || printf '[caddy-sync] Caddy API unavailable or route restore failed; retrying.\n' >&2
  fi
  sleep 30
done
