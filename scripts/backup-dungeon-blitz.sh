#!/usr/bin/env bash
set -euo pipefail

project_dir="/home/admin/DungenBlitz"
data_dir="${project_dir}/src/server/data"
backup_dir="${project_dir}/backups"
timestamp="$(date -u +'%Y-%m-%d-%H%M')"
destination="${backup_dir}/backup-${timestamp}.tar.gz"

mkdir -p "${backup_dir}"
chmod 700 "${backup_dir}"

items=()
[[ -f "${data_dir}/Accounts.json" ]] && items+=("Accounts.json")
[[ -d "${data_dir}/saves" ]] && items+=("saves")

if ((${#items[@]} == 0)); then
  echo "No persistent account/save data found." >&2
  exit 1
fi

tar -C "${data_dir}" -czf "${destination}" "${items[@]}"
chmod 600 "${destination}"

find "${backup_dir}" -maxdepth 1 -type f -name 'backup-*.tar.gz' -mtime +30 -delete
printf '%s\n' "${destination}"
