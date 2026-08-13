#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="${RUFFLE_SOURCE_DIR:-/tmp/ruffle-dbr-source}"
output_dir="${1:-${project_dir}/src/client/content/localhost/ruffle-dbr-build}"
ruffle_pr_head="684cf8270166b9230216002f4e617778468c84c3"
compat_patch="${project_dir}/patches/ruffle-dungeon-blitz-read-graphics-data.patch"
goto_placebyclass_patch="${project_dir}/patches/ruffle-dungeon-blitz-placebyclass-goto.patch"
lifecycle_trace_patch="${project_dir}/patches/ruffle-dungeon-blitz-lifecycle-trace.patch"
readgraphics_trace_patch="${project_dir}/patches/ruffle-dungeon-blitz-readgraphics-trace.patch"
runtime_label="${DBR_RUNTIME_LABEL:-v4}"
# Diagnostic-only: logs a console warning on every call to a short, hardcoded list of
# obfuscated Dungeon Blitz client methods (see the patch file) so a live browser run can
# capture the actual room-transition/physics lifecycle order. Never enable for a runtime
# meant to be played normally -- it adds a per-AVM2-call string check everywhere.
enable_lifecycle_trace="${DBR_ENABLE_LIFECYCLE_TRACE:-0}"
# Diagnostic-only: logs a call-count marker every 250 calls to Graphics.readGraphicsData, to
# measure whether the game calls it every frame against static collision geometry (a
# suspected performance hot spot -- see docs/RUFFLE_BROWSER_COMPATIBILITY.md). No behavior
# change, just a call counter.
enable_readgraphics_trace="${DBR_ENABLE_READGRAPHICS_TRACE:-0}"

for command in git npm cargo rustup wasm-bindgen; do
  command -v "${command}" >/dev/null || {
    printf 'Missing required build command: %s\n' "${command}" >&2
    exit 1
  }
done

if [[ ! -d "${source_dir}/.git" ]]; then
  git clone --filter=blob:none https://github.com/ruffle-rs/ruffle.git "${source_dir}"
fi

git -C "${source_dir}" fetch origin pull/23790/head
git -C "${source_dir}" checkout --detach "${ruffle_pr_head}"
git -C "${source_dir}" reset --hard "${ruffle_pr_head}"
git -C "${source_dir}" apply --check "${compat_patch}"
git -C "${source_dir}" apply --check "${goto_placebyclass_patch}"
git -C "${source_dir}" apply "${compat_patch}"
git -C "${source_dir}" apply "${goto_placebyclass_patch}"

if [[ "${enable_lifecycle_trace}" == "1" ]]; then
  git -C "${source_dir}" apply --check "${lifecycle_trace_patch}"
  git -C "${source_dir}" apply "${lifecycle_trace_patch}"
fi

if [[ "${enable_readgraphics_trace}" == "1" ]]; then
  git -C "${source_dir}" apply --check "${readgraphics_trace_patch}"
  git -C "${source_dir}" apply "${readgraphics_trace_patch}"
fi

rustup toolchain install nightly \
  --profile minimal \
  --component rust-src \
  --target wasm32-unknown-unknown

(
  cd "${source_dir}/web"
  npm ci
  CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}" \
  CARGO_PROFILE_WEB_WASM_EXTENSIONS_OPT_LEVEL=2 \
  CARGO_PROFILE_WEB_WASM_EXTENSIONS_CODEGEN_UNITS=256 \
  CARGO_PROFILE_WEB_WASM_EXTENSIONS_DEBUG=0 \
    npm run build --workspace=ruffle-core
  npm run build --workspace=ruffle-selfhosted
)

install -d -m 755 "${output_dir}"
cp -a "${source_dir}/web/packages/selfhosted/dist/." "${output_dir}/"
cat >"${output_dir}/DUNGEON_BLITZ_BUILD.txt" <<EOF
Dungeon Blitz browser compatibility build
Runtime: ${runtime_label}
Base: ruffle-rs/ruffle PR #23790 at ${ruffle_pr_head}
Local patch: patches/ruffle-dungeon-blitz-read-graphics-data.patch
Graphics compatibility: fills plus colored SWF strokes for world collision
Local patch: patches/ruffle-dungeon-blitz-placebyclass-goto.patch
Build profile: web-wasm-extensions opt-level=2 codegen-units=256
EOF

if [[ "${enable_lifecycle_trace}" == "1" ]]; then
  cat >>"${output_dir}/DUNGEON_BLITZ_BUILD.txt" <<EOF
Local patch: patches/ruffle-dungeon-blitz-lifecycle-trace.patch
Diagnostic-only: logs [DBR-SEQ] on room/collision/physics lifecycle calls
EOF
fi

if [[ "${enable_readgraphics_trace}" == "1" ]]; then
  cat >>"${output_dir}/DUNGEON_BLITZ_BUILD.txt" <<EOF
Local patch: patches/ruffle-dungeon-blitz-readgraphics-trace.patch
Diagnostic-only: logs [DBR-RGD] call-count markers for Graphics.readGraphicsData
EOF
fi

printf 'Ruffle Dungeon Blitz build written to %s\n' "${output_dir}"
