#!/usr/bin/env bash
set -euo pipefail

# Installs a CI-produced self-hosted Ruffle bundle as an isolated v4 test runtime.
# It deliberately does not restart PM2/Caddy, touch /, or replace ruffle-dbr-v3.

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
content_dir="${project_dir}/src/client/content/localhost"
destination="${content_dir}/ruffle-dbr-v4"
source_path="${1:-}"

if [[ -z "${source_path}" || ! -e "${source_path}" ]]; then
  printf 'Usage: %s <ruffle-dbr-v4 artifact directory | .tar.gz archive>\n' "$0" >&2
  exit 64
fi

parent_dir="$(dirname "${destination}")"
staging="$(mktemp -d "${parent_dir}/.ruffle-dbr-v4.staging.XXXXXX")"
cleanup() { rm -rf "${staging}"; }
trap cleanup EXIT

if [[ -d "${source_path}" ]]; then
  cp -a "${source_path}/." "${staging}/"
elif [[ "${source_path}" == *.zip ]]; then
  command -v unzip >/dev/null || {
    echo 'unzip is required to deploy a GitHub Actions .zip artifact' >&2
    exit 65
  }
  unzip -q "${source_path}" -d "${staging}"
else
  tar -xzf "${source_path}" -C "${staging}"
fi

# GitHub artifact archives may contain one top-level directory.
shopt -s nullglob dotglob
entries=("${staging}"/*)
if [[ ${#entries[@]} -eq 1 && -d "${entries[0]}" ]]; then
  nested="${entries[0]}"
  mkdir "${staging}/.unpacked"
  cp -a "${nested}/." "${staging}/.unpacked/"
  rm -rf "${nested}"
  mv "${staging}/.unpacked/." "${staging}/"
  rmdir "${staging}/.unpacked"
fi

[[ -f "${staging}/ruffle.js" ]] || { echo 'Artifact is missing ruffle.js' >&2; exit 65; }
find "${staging}" -type f -name '*.wasm' -print -quit | grep -q . || {
  echo 'Artifact is missing a WebAssembly file' >&2
  exit 65
}

backup=""
if [[ -e "${destination}" ]]; then
  backup="${destination}.previous-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "${destination}" "${backup}"
fi
mv "${staging}" "${destination}"
trap - EXIT

printf 'Installed Ruffle v4 test runtime: %s\n' "${destination}"
[[ -z "${backup}" ]] || printf 'Previous v4 runtime retained at: %s\n' "${backup}"
printf 'Test only at: https://dungenblitz.ecliptia.net/play-test/?v=4\n'
