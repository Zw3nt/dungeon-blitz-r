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

## White tutorial/quest-arrow rectangle investigation

Real browser testing (2026-08-12) found large white rectangles in place of
several UI indicator graphics: the down/left/right tutorial direction
arrows and the notify icon that floats above quest NPCs. Static analysis of
the decompiled client SWFs (`ffdec-cli`, JPEXS FFDec 26.2.1) found the
mechanism these graphics share:

1. `class_4` (in `DungeonBlitz.swf`'s main ABC) has a static factory method
   `method_16(className: String): MovieClip`. It resolves the class via
   `ApplicationDomain.currentDomain.hasDefinition`/`getDefinition` (checking
   every loaded library SWF in the shared domain, not just the calling
   SWF) and `construct()`s it. This is the generic "instantiate a linked
   library symbol by name" path used across the client, independent of our
   custom Ruffle `readGraphicsData` collision patch.
2. `Entity.method_397` (methodIdx 713 in `DungeonBlitz.swf`) calls
   `class_4.method_16("a_Notify_ActiveQuest" | "a_Notify_NewQuest" |
   "a_Notify_ReturnQuest")` to create the floating notify icon above a quest
   NPC's head. These three symbols are defined (via the SWF `SymbolClass`
   tag) in `UI_1.swf` as character ids 2706/2704/2702 respectively — a
   bouncing-pin sprite (79-frame Y-tween) wrapping a nested shape,
   **character id 597**, that is placed with `PlaceObject3` carrying a
   `surfaceFilterList` with a single **`GLOWFILTER`**:
   `blurX=5.0 blurY=5.0 strength=1.5 compositeSource=true` and glow color
   `rgba(255,254,236,255)` — i.e. an almost-pure-white glow.
3. `class_97.method_927` (methodIdx 1779) is the direction-arrow driver: it
   calls `this.method_187("am_ArrowGoLeft"/"am_ArrowGoRight")` /
   `this.method_290(...)` depending on `mbVisible`. Unlike the notify icon,
   no loaded local SWF exports a `SymbolClass` for `am_ArrowGoLeft`/
   `am_ArrowGoRight`/`am_ArrowUp`/`am_ArrowDown`, so `method_187`/`method_290`
   most likely address an already-placed named timeline child (matching the
   `am_TutorialInteraction`/`am_ArrowUp`/`am_ArrowDown` instance properties
   found on several `ScreenXxx.OnCreateScreen` classes) rather than
   constructing a new object by class name. This half of the investigation
   is not yet finished — it needs the same character-id trace applied to
   whatever symbol backs those instance properties.

Working hypothesis: Ruffle's `GLOWFILTER` render pass
(`render/wgpu/src/filters/glow.rs` + `render/wgpu/shaders/filter/glow.wgsl`
at the pinned fork commit) is implemented as a standard wgpu render
pipeline, so it is not obviously unimplemented on the `wgpu-webgl` backend;
the fetched source does not show a webgl-specific gap. The near-white glow
color is suspicious only because it matches the reported symptom almost
exactly (a light/white rectangle appearing where a bouncing arrow/pin
should be) — this is not yet confirmed against an actual render. No SWF
patch or Ruffle patch has been applied for this yet.

### 2026-08-12 live-render attempt: not reproduced yet

Built a fully isolated local instance (separate ports 18080/18081/18090,
separate copy of `src/server` with a fresh `Accounts.json`/`saves/`, real
files rather than symlinks so `Config.DATA_DIR` resolution can't walk back
to the real repo -- an earlier attempt that symlinked whole directories did
exactly that and briefly rewrote the real local playtest account's password
before being caught and reverted via `git checkout`; the lesson is to only
symlink leaf files/directories that config resolution never treats as an
anchor, never a parent of any server source file). A small
`play-test-isolated/index.html` variant (not the shared `play-test/`) points
Ruffle's `socketProxy` at the isolated `RuffleSocketProxy`. The client's
`localhost:8000` master-file-list fetch is hardcoded independent of the
static port, so a Playwright `page.route()` handler fetches it from the real
isolated static port and fulfills the response directly (fulfilling instead
of continuing avoids a same-origin/CORS mismatch).

Through this harness: logged in, created a brand-new character (Mage,
confirming the gender/appearance preview screen itself renders correctly),
entered TutorialBoat, walked the full length of the boat, and clicked
through the captain's dialogue repeatedly. Observed the "Ranged Attacks"
tutorial hint box, a glowing blue target reticle over a flying enemy (a
filter-adjacent effect that rendered correctly), the parrot, and the
captain NPC -- across roughly 20 screenshots, **no white rectangle
appeared anywhere**, including in UI that visually resembles filtered
content. The `a_Notify_NewQuest` icon specifically was never confirmed
on-screen: the captain (`ac_NPCCaptainSteering`, not a quest giver) never
produced it, and repeated dialogue clicks didn't advance the tutorial past
the ranged-attack hint.

Net effect: this session did not reproduce the reported symptom, which
somewhat weakens (but does not rule out) the GlowFilter hypothesis -- it
does rule out a *blanket* wgpu-webgl filter rendering failure, since a
similar glow-style effect (the target reticle) rendered fine. What's
missing is specifically triggering `a_Notify_NewQuest`/`a_Notify_ActiveQuest`
on screen. Not yet done, in priority order for whoever continues this:

1. **Real-user correction (2026-08-12, from direct testing, higher priority
   than the leads below):** the rectangle is not near the captain and is
   not TutorialBoat-boat-deck content at all. It appears **after leaving
   the boat, at the moment the game drops the player onto the beach map**
   -- i.e. at the same TutorialBoat -> Beach room transition already
   tracked below under "Generic room-transition spawn/collision race".
   This live session tried to reach that exact moment (fresh character,
   full boat walk, ~26 combat-input attempts at the intro bat with mouse
   clicks + ability hotkeys 1/2 aimed at its screen position) and could
   not reliably land a hit -- mana moved from 0 to 5/80 once, meaning at
   most one cast connected across the whole session, so the intro fight
   was never cleared and the boat -> beach transition was never reached.
   Blind coordinate-based clicking is not a reliable way to fight a moving
   flying target headlessly. Whoever continues this should either drive
   the fight with proper hit-testing (e.g. read the enemy's actual stage
   coordinates from a debug trace instead of a fixed guess) or, more
   simply, use `debugPlayerBuild=` with a small instrumented SWF that
   force-completes the intro encounter/skips straight to the boat -> beach
   door, then capture the arrival frame. This also means white-arrow and
   the room-transition fall-through bug may share one root cause -- fix
   room-transition lifecycle first and re-check whether the rectangle is
   still there.
2. Separately, find a game state that shows `a_Notify_ActiveQuest`/
   `a_Notify_NewQuest` on-screen away from a room transition (a party
   member/alt account with a pending but unaccepted quest may be more
   reliable than a freshly-created character; the seeded local playtest
   account's "New*" characters already have 1 mission in progress via
   `seedTestAccount.ts` and never showed the marker either). Screenshot it
   and compare the rectangle bounds against character 597's glow bounds.
3. If confirmed, bisect whether the bug is `compositeSource=true` specific
   (Ruffle's shader comments call it "undocumented flash feature") by
   testing a filtered element that does not use `compositeSource` for
   comparison.
4. Finish tracing `class_97.method_927`'s `method_187`/`method_290` targets
   to confirm or rule out the same glow-filter mechanism for the
   left/right/up/down tutorial arrows.
5. Only if Ruffle's filter rendering is confirmed broken for this case,
   patch it upstream in the pinned fork (same GitHub Actions build/deploy
   flow as the collision patches) -- do not strip the filter from the SWF
   client-side as a workaround; that changes shipped visual design instead
   of fixing the renderer.

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

### Generic room-transition spawn/collision race (entry point for next session)

Real testing found the player fall through the floor once, specifically on
the TutorialBoat -> Beach transition's first spawn (see the top-level
handoff notes for this investigation). `Level.method_1195` (methodIdx 1226
in `DungeonBlitz.swf`) is the shared level-construction entry point but is
mostly generic bookkeeping; it is not where a room's children (and their
collision objects) get recursively instantiated per-level. That lives in
level-specific classes bundled inside each `LevelsXX.swf`. For
`LevelsTut.swf` specifically, `ffdec-cli -export symbolClass` (or listing
`abc.instances` with the same `swfPatchUtils` tooling used for the arrow
investigation above) shows the relevant classes: `a_Level_TutorialBoat`,
`a_Room_TutorialBoat_R01`, `a_PlayerSpawn`, `a_LevelDirector`,
`a_RoomDirector`. Since the bug reproduced on a *transition between two
different level SWFs* rather than within one already-loaded level, the
generic fix is most likely in `a_LevelDirector`/`a_RoomDirector` (present,
under those or equivalent obfuscated names, in every `LevelsXX.swf`) or in
whatever base `Level`/`Room` class they extend in `DungeonBlitz.swf` --
specifically wherever player spawn is triggered relative to the new room's
collision-object registration (`class_154.method_444`) completing. This has
not been traced yet; do that next, the same way the TutorialBoat collision
stroke bug was traced (grep for `Loader`/`addEventListener`/`Event.COMPLETE`
around the spawn call to find whether spawn can run before an
asynchronously-loaded room's collision finishes registering).

**Update (2026-08-12):** direct testing reports the white-rectangle bug
(see "White tutorial/quest-arrow rectangle investigation" above) also
happens at this exact transition -- right after being dropped onto the
beach map, not near the boat's captain. The two bugs may share one root
cause in this transition's lifecycle (something briefly wrong right after
a new room is instantiated, before it settles: collision registration
racing spawn placement for one, and possibly the same window causing a
freshly-constructed `class_4.method_16` object like the notify icon to
render one bad frame before its texture/filter state is ready). Investigate
the room-transition ordering first; it may fix both at once.

`a_RoomDirector`/`a_LevelDirector` (dumped via the same `swfPatchUtils`
tooling) turned out to be trivial data classes -- `a_RoomDirector` has only
`thinkOnEnter: String`, `thinkOnCompletion: String`, `thinkOnHit: Array`
instance fields and no methods; `a_LevelDirector` has only a `type: String`
field. They are declarative cue definitions, not the logic that processes
them.

**Update (2026-08-12), spawn resolution traced and ruled out as the race:**
`ffdec-cli -export script -format script:as` gives readable (if
control-flow-mangled by the pinned build's obfuscator) decompiled
ActionScript, which is far more productive here than reading raw p-code.
The recursive per-room child dispatcher is `Level.method_232`. It matches
children by both `is <Class>` (`a_RoomDirector`, `a_Hotspot`, ...) and by
instance-name string prefix (`"a_Door_"`, `"a_DoorMarker"`, `"a_PlayerSpawn"`
compared with `_loc15_ == "a_PlayerSpawn"`). The player-spawn branch is:

```as3
if (_loc15_ == "a_PlayerSpawn") {
    this.var_239 = new Point();
    this.var_2549 = this.method_269(_loc14_, this.var_239);
    break loop93;
}
```

`method_269(child, point)` (`Level.as:4497`) does nothing but read
`child.transform.concatenatedMatrix.tx/ty` into the point and hide the
marker (`visible = false`) -- a pure, synchronous coordinate readout with
no physics or collision interaction at all. `Level.method_1195` asserts
`class_24.method_19("Level needs a PlayerSpawn")` if `var_239` is still
null after the room-children pass, confirming spawn-point resolution
happens inside the same single synchronous pass as `a_RoomDirector` and
collision-object handling, in document (timeline child) order, for one
already-loaded room's SWF. There is no `Loader`/`addEventListener` visible
in this method, so **this pass itself is not where the race is** -- for a
single already-loaded level, spawn position and collision registration
both complete before the method returns, matching what was already known
to work for TutorialBoat's *own* room.

**Update (2026-08-12), the per-frame physics ticker traced end to end:**
followed the call graph forward from the actual `ENTER_FRAME` listener
down to the gravity constant:

```text
Main.Init()                    -- addEventListener(Event.ENTER_FRAME, method_1284)
  Main.method_1284(evt)         -- iterates every active Game in var_523, ticks each one unconditionally
    Game.method_1636() / method_789()   -- MASTER_CLIENT dev flag picks one; both reachable
      Game.method_1296()        -- per-entity update dispatch (gated on this.serverConn etc, not on level readiness)
        Game.method_1970()
          Entity.method_1366() / method_1770()
            Entity.method_864() -- reads GRAVITY (multiname idx 2034), applies velocity/currSurface/entState
```

`Main.method_1284` ticks *every* `Game` instance in `var_523` every frame
with no visible check for "is this Game's current level finished loading."
`Game.method_1296`'s early checks are about server connection state and a
tooltip/HUD refresh helper (`method_1337`, which turned out to be an
unrelated cached-stat-diff check for HUD redraw, not a readiness gate --
don't re-investigate it, it's a dead end already ruled out). No level- or
collision-readiness guard was found anywhere in this chain by reading the
decompiled source.

Working theory, now fairly well supported: a room transition does not
replace the `Game` object, so `Main.method_1284` never stops ticking the
player's `Entity.method_864` physics across the transition. While the new
level's SWF is asynchronously `Loader`-ing (network + parse time), the
player entity keeps receiving gravity ticks against whatever
`currSurface`/collision state is currently cached -- stale from the old
room, or absent -- until the new level SWF's `Level.method_1195` finishes
its synchronous `method_232` pass (collision registration + spawn point,
proven above to be atomic together) and corrects both. That gap is the
fall. This matches the reported symptom exactly: one brief, self-correcting
fall right as the new room appears, not a persistent one.

This has not been confirmed with an actual timestamp trace (no
instrumentation added yet -- doing so needs an AS3 bytecode patch that
calls `trace()`/`ExternalInterface.call` at `Entity.method_864` entry and
at `class_154.method_444` entry/exit, in the same style as the existing
`scripts/patch-dungeonblitz-*.ts` scripts, then a `debugPlayerBuild=`
Playwright run with `?debug=1` to capture Ruffle's `traceObserver` output
across TutorialBoat -> Beach). If confirmed, the generic fix is almost
certainly one of:

1. Suspend/skip `Entity.method_864` (or its callers) for the player entity
   while the current level's `Level.method_1195` hasn't completed for the
   *new* room -- needs a "level ready" flag Level can set and Game/Entity
   can check.
2. Don't let the old room's collision (`class_154`'s registered surfaces)
   get cleared until the new room's is ready, so `currSurface` stays valid
   across the gap instead of going stale/null.
3. Keep the player's grounded flag/Y position frozen from the moment a
   transition starts until the new room's spawn point + collision are both
   set, rather than letting gravity free-run in between.

Whichever is chosen, it should live in the shared tick/transition path
(`Main`/`Game`/`Entity`/`Level`), not per-level, so it fixes every room
transition at once rather than just TutorialBoat -> Beach.

### Required v4 acceptance test

A v4 build is **not** considered successful until a normal browser test proves:

- the `Unexpected PlaceObject during goto: PlaceByClass` console error is gone;
- the local player's `m_Sprite.numChildren` remains nonzero after creation;
- the player remains visible through subsequent frames;
- idle and walk animation work after a NewbieRoad transfer;
- login, character selection, HUD, WSS, movement, camera and save persistence
  still pass.

No v4 artifact has been deployed or accepted yet.
