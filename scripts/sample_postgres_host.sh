#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
compose=(docker compose -f compose.yml -f tunnel.yml)

pg_container=$("${compose[@]}" ps -q postgres)
tunnel_container=$("${compose[@]}" ps -q cloudflared)
postgres_restarts=$(docker inspect --format '{{.RestartCount}}' "$pg_container")
tunnel_restarts=$(docker inspect --format '{{.RestartCount}}' "$tunnel_container")
data_mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$pg_container")
[[ -d $data_mount ]]
read -r disk_total disk_free < <(df -PB1 "$data_mount" | awk 'NR==2 {print $2, $4}')
read -r mem_total mem_available < <(awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {printf "%.0f %.0f\n", total*1024, available*1024}' /proc/meminfo)
tls_expiration=$(openssl x509 -in "${1:?PostgreSQL server certificate path required}" -noout -enddate)
tls_epoch=$(date -u -d "${tls_expiration#notAfter=}" +%s)
for number in "$disk_total" "$disk_free" "$mem_total" "$mem_available" "$tls_epoch" "$postgres_restarts" "$tunnel_restarts"; do
  [[ $number =~ ^[0-9]+$ ]]
done
"${compose[@]}" exec -T postgres psql -X -q -p 25432 -U postgres -d nodema -v ON_ERROR_STOP=1 \
  -v disk_total="$disk_total" -v disk_free="$disk_free" \
  -v mem_total="$mem_total" -v mem_available="$mem_available" -v tls_epoch="$tls_epoch" \
  -v postgres_restarts="$postgres_restarts" -v tunnel_restarts="$tunnel_restarts" <<'SQL'
BEGIN;
INSERT INTO host_capacity_samples (disk_free,disk_total,db_bytes,pg_connections,
  mem_available,mem_total,tls_expires_at,postgres_restarts,tunnel_restarts)
SELECT :disk_free,:disk_total,pg_database_size(current_database()),
  (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
    AND backend_type='client backend' AND pid<>pg_backend_pid()),:mem_available,:mem_total,
  to_timestamp(:tls_epoch),:postgres_restarts,:tunnel_restarts;
DELETE FROM host_capacity_samples WHERE taken_at < now()-interval '14 days';
COMMIT;
SQL
