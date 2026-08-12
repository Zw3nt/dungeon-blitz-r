# Dungeon Blitz browser compatibility

## Active test build

- Endpoint: `/play-test/`
- Self-hosted runtime: `/ruffle-dbr-v3/`
- Ruffle base: full head of `ruffle-rs/ruffle` PR `#23790`
- Additional patch: `patches/ruffle-dungeon-blitz-read-graphics-data.patch`
- Rebuild helper: `scripts/build-ruffle-dbr.sh`

The runtime URL is versioned deliberately. Public static assets can be cached for
four hours, so reusing an old runtime path can leave browsers on a known-bad WASM
build after the server has been updated.

## Compatibility fixes

1. PR `#23790` adds support for AS3 `PlaceObject3` records that instantiate a
   display object by class name. This removes the `Invalid PlaceObject type`
   failures and the resulting `removeChildAt(0)` crash during world loading.
2. The local patch implements the subset of `Graphics.readGraphicsData(true)`
   used by Dungeon Blitz. It recursively flattens child vector shapes, applies
   display transforms, and returns solid-fill/path/end-fill records. This fixes
   the black character paper doll on the character-selection screen.
3. The browser host prefers WebGPU, with Ruffle's normal fallback chain, and
   defaults to medium quality (2x MSAA) to reduce initialization and rendering
   overhead. Renderer and quality can be overridden for diagnostics:
   `?renderer=wgpu-webgl&quality=high`.

## Verified

- SWF boot
- account login over authenticated WSS-to-TCP bridge
- character list
- equipped character paper doll rendering
- login-to-world transfer over a second WSS connection
- NewbieRoad server login and initial packet exchange
- no Ruffle panic, `Invalid PlaceObject`, or ActionScript `RangeError #2006`
  with the v3 build

## Still under verification

- visible animated player sprite in the world
- long-session movement and combat rendering
- two-player browser gameplay
- Firefox and Edge hardware-backed renderer behavior

## World-player diagnostics

The local-player packet and entity are valid: the client enters NewbieRoad, the
HUD is initialized, movement changes the camera and the save position is
updated. Instrumented SWFs also established the following:

- `clientEnt`, `gfx`, `m_Data` and `m_Seq` are created.
- `gfx.m_TheDO` is contained by `playerEntLayer`, is visible with alpha `1`, and
  has the expected world position.
- Before an explicit `SuperAnimInstance.method_105()` call, `m_Sprite` has no
  children and `var_151.bitmapData` is null.
- One explicit `method_105()` call creates a child and changes the avatar bounds
  from the diagnostic 80x80 marker to roughly 123x189. This proves that the
  SuperAnim data exists and can construct a world-avatar frame.
- `Game.var_961` contains the local player's instance (observed indices 120+).
  `Game.method_1325()` runs continuously and, once the world client exists,
  resolves the current player gfx inside that vector.
- Instrumentation of `SuperAnimInstance.method_105()` confirms that the normal
  scheduler does call the player instance (about 11–12 calls/sec in the
  memory-constrained headless test). The instance is therefore not missing
  registration or a frame scheduler.
- The player's `m_Sprite.numChildren` is observed as `0 → 1 → 0`: a world
  frame can be constructed and is subsequently lost on a later frame/reset.
- Every such test logs Ruffle's concrete unimplemented path:
  `Unexpected PlaceObject during goto: PlaceObjectAction::PlaceByClass`.
  The existing custom runtime handles this action during ordinary tag
  processing but not during `MovieClip::goto_frame`, which is the active
  world-SuperAnim path.

The next engine fix applies the same `PlaceByClass` placement logic to
`MovieClip::goto_frame`. It is stored as
`patches/ruffle-dungeon-blitz-placebyclass-goto.patch` and is included in
`scripts/build-ruffle-dbr.sh`; it has not been deployed until a new Ruffle
WASM build can be compiled and browser-regression-tested.

Debug SWFs are selected without replacing production assets by using
`/play-test/?debugPlayerBuild=<name>`.

Do not replace the production Flash fallback until the world sprite, movement,
combat, and long-session checks pass.

## Reproducible v4 build (outside the VPS)

The v4 bundle is intentionally built outside the VPS. It does not alter the
production `/` route or the v3 runtime.

Pinned inputs:

- Ruffle source: PR #23790 head commit
  `684cf8270166b9230216002f4e617778468c84c3`
- Rust: `nightly` with `rust-src` and the `wasm32-unknown-unknown` target
  (the pinned Ruffle source declares `nightly` in `rust-toolchain.toml`)
- Node.js: `24` (the pinned Ruffle source's own web CI uses Node 24)
- npm: the version bundled with Node 24; dependencies are locked by
  `web/package-lock.json` and installed with `npm ci`
- `wasm-bindgen-cli`: `0.2.120`, matching the source's locked
  `wasm-bindgen` crate
- `wasm-opt`: Binaryen `version_129`

The build applies, in order:

1. `patches/ruffle-dungeon-blitz-read-graphics-data.patch`
2. `patches/ruffle-dungeon-blitz-placebyclass-goto.patch`

From a checkout of this repository, run:

```bash
RUFFLE_SOURCE_DIR="$PWD/.cache/ruffle-dbr-source" \
CARGO_BUILD_JOBS=1 \
./scripts/build-ruffle-dbr.sh ./ruffle-dbr-v4
```

The output directory is a self-hosted Ruffle distribution containing
`ruffle.js`, the WASM bundle, and `DUNGEON_BLITZ_BUILD.txt`.

## TutorialBoat collision investigation and isolated v5 candidate

`LevelsTut.swf` contains `a_Level_TutorialBoat`, whose room
`a_Room_TutorialBoat_R01` places `am_CollisionObject`. That object contains
the floor and trigger geometry as colored **SWF strokes**: its principal
shape is character `156` and includes the floor-colored `LINESTYLE2` paths.

Dungeon Blitz parses these paths by calling
`Graphics.readGraphicsData(false)` and reading each
`GraphicsStroke -> GraphicsPath` pair into `CollisionManager`. The initial
local graphics compatibility patch returned fills only, so it could render
paper dolls but discarded TutorialBoat's stroke-only collision object. This
is a concrete client-side explanation for a missing floor while the server
continues to receive no falling movement packets.

The updated graphics patch preserves colored stroke paths as
`GraphicsStroke -> GraphicsPath`; it does not hardcode player coordinates or
alter game physics. The original source order is synchronous:

1. `ResourceManager` completes `LevelsTut.swf`;
2. `Level.method_1195()` creates `a_Level_TutorialBoat`;
3. it creates `a_Room_TutorialBoat_R01` and recursively processes its
   children;
4. `class_154.method_444(am_CollisionObject, ..., collMan)` registers the
   collision lines before `Level.method_1195()` completes.

The v5 candidate is intentionally isolated from v3/v4. It must stay on the
test URL until the final manual browser check confirms grounded idle/walk and
the missing world region on a real GPU-backed client.

### v5 validation checkpoint

2026-08-12 UTC:

- GitHub Actions run `31552742588` (`Build Dungeon Blitz Ruffle v5`) completed
  successfully for commit `c75b0c9`.
- The CI artifact was deployed only to
  `src/client/content/localhost/ruffle-dbr-v5/`; no production route, v3
  runtime, PM2 process, or Caddy route was changed.
- Authenticated HTTP checks returned `200` for the v5 play-test host page,
  `/ruffle-dbr-v5/ruffle.js`, and `/ruffle-dbr-v5/DUNGEON_BLITZ_BUILD.txt`.
- A Playwright Chromium run at
  `/play-test/?v=5&renderer=wgpu-webgl&quality=medium&debug=1` selected
  TutorialBoat character `Vf014603`, loaded
  `/p/cbp/LevelsTut.swf` with status `200`, and opened the world WSS
  connection.
- Screenshots `/tmp/dbr-v5-tb-idlewalk-09-idle9.png` through
  `/tmp/dbr-v5-tb-idlewalk-27-postleft3.png` show the player grounded on
  TutorialBoat through idle, right-walk, post-right idle, left-walk, and
  post-left idle samples. No continuous falling or camera runaway was visible,
  and the boat/world layers rendered normally.
- The same run reported no page errors and no console hits for
  `PlaceByClass`, `PlaceObject`, `readGraphicsData`, `Collision`,
  `RangeError`, `TypeError`, panic, or AVM2 error. The only non-game failures
  were blocked GameAnalytics requests and the optional presence endpoint.

Manual external browser validation is still requested before promoting v5 to a
default runtime.

### Build and deploy v5

The GitHub Actions workflow `.github/workflows/build-ruffle-dbr-v5.yml`
builds the patched artifact as `ruffle-dbr-v5`. After downloading that
artifact to the VPS:

```bash
./scripts/deploy-ruffle-dbr-v5.sh /path/to/ruffle-dbr-v5.zip
```

This only installs `src/client/content/localhost/ruffle-dbr-v5/`. Test it
only at:

```text
https://dungenblitz.ecliptia.net/play-test/?v=5&renderer=wgpu-webgl
```

### GitHub Actions artifact

`.github/workflows/build-ruffle-dbr-v4.yml` builds the same pinned source and
uploads a downloadable `ruffle-dbr-v4` artifact. It can be started manually
from **Actions → Build Dungeon Blitz Ruffle v4 → Run workflow**. The workflow
uses the exact toolchain versions above and validates that the output contains
both `ruffle.js` and a WASM file.

### VPS v4 test deployment

Do not overwrite `/ruffle-dbr-v3/`. Download the CI artifact and run:

```bash
./scripts/deploy-ruffle-dbr-v4.sh /path/to/ruffle-dbr-v4.zip
```

The deploy script validates the artifact, atomically installs only
`src/client/content/localhost/ruffle-dbr-v4/`, and retains an existing v4
bundle as a timestamped rollback directory. It does not restart PM2 or Caddy.

Then test only:

```text
https://dungenblitz.ecliptia.net/play-test/?v=4
```

`/play-test/` and `/play-test/?v=3` continue to load `/ruffle-dbr-v3/`.

### Required v4 acceptance test

A v4 build is **not** considered successful until a normal browser test proves:

- the `Unexpected PlaceObject during goto: PlaceByClass` console error is gone;
- the local player's `m_Sprite.numChildren` remains nonzero after creation;
- the player remains visible through subsequent frames;
- idle and walk animation work after a NewbieRoad transfer;
- login, character selection, HUD, WSS, movement, camera and save persistence
  still pass.

No v4 artifact has been deployed or accepted yet.
