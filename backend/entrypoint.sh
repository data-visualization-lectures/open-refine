#!/bin/bash
set -euo pipefail

if [ -z "${PORT:-}" ]; then
  echo "ERROR: PORT not set"
  exit 1
fi

if [ -z "${OPENREFINE_SHARED_SECRET:-}" ]; then
  echo "ERROR: OPENREFINE_SHARED_SECRET not set"
  exit 1
fi

envsubst '${PORT} ${OPENREFINE_SHARED_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

nginx -g "daemon off;" &
NGINX_PID=$!

/opt/openrefine/refine \
  -i 127.0.0.1 -p 3333 \
  -m "${REFINE_MEMORY:-1400M}" \
  -x refine.headless=true -d /data &
REFINE_PID=$!

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3333/ > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ERROR: OpenRefine failed to start"
    exit 1
  fi
  sleep 1
done
echo "OpenRefine ready"

wait -n "$NGINX_PID" "$REFINE_PID"
