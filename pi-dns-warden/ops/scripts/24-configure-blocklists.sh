#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$ROOT_DIR/ops/lib/load-env.sh"
load_env_file "$ROOT_DIR/.env"
# shellcheck disable=SC1091
source "$ROOT_DIR/ops/scripts/_compose.sh"

selection="${TORHOLE_BLOCKLISTS:-stevenblack}"
IFS=',' read -r -a selected_ids <<<"$selection"
if [[ ${#selected_ids[@]} -eq 0 ]]; then
  echo "ERROR: select at least one blocklist."
  exit 1
fi

sql="BEGIN; UPDATE adlist SET enabled=0 WHERE address IN ('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts','https://big.oisd.nl','https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt');"
for id in "${selected_ids[@]}"; do
  case "$id" in
    stevenblack)
      url="https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"
      ;;
    oisd)
      url="https://big.oisd.nl"
      ;;
    adguard)
      url="https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt"
      ;;
    *)
      echo "ERROR: unsupported blocklist selection: $id"
      exit 1
      ;;
  esac
  sql+=" INSERT OR IGNORE INTO adlist(address,enabled,comment) VALUES('${url}',1,'Managed by Torhole Advanced'); UPDATE adlist SET enabled=1,comment='Managed by Torhole Advanced' WHERE address='${url}';"
done
sql+=" COMMIT;"

services=(pihole_trusted)
if [[ "${TORHOLE_TOPOLOGY:-vlan}" == "vlan" ]]; then
  services+=(pihole_iot)
fi

for service in "${services[@]}"; do
  echo "Applying blocklists to ${service}: ${selection}"
  "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml \
    exec -T "$service" pihole-FTL sqlite3 /etc/pihole/gravity.db "$sql"
  "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.monitoring.yml \
    exec -T "$service" pihole -g
done

echo "Selected Advanced blocklists installed and gravity refreshed."
