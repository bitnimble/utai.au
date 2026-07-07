# Native desktop audio engine, Sub-project A (design)

Status: approved shape, pre-implementation. Date: 2026-07-07.

## Goal

Give the **Tauri desktop build** a native audio engine so the karaoke
mic-monitor round-trip (sing → hear yourself over the backing track) drops from
Web Audio's tens-of-ms into single-digit ms. Native audio can't run in a
browser, so this is desktop-only; **web and Android keep using Web Audio**
unchanged.

Sub-project A delivers the engine on **cpal's default backends** (WASAPI shared
on Windows, CoreAudio on macOS, ALSA/JACK on Linux) with full feature parity to
today's Web Audio path. The ASIO / WASAPI-exclusive low-latency layer is
**Sub-project B** (separate spec).

## Background: current state

- All audio lives in the webview's Web Audio graph. `JotPlayer` (singleton
  `jotPlayer`, `frontend/src/editing/playback/player.ts`) owns the
  `AudioContext`, a master gain bus, per-track playback, the rAF playhead loop,
  and transport state (`state`, `currentTime`, `timeline`, `durationSec`,
  `audioTracks`). It's imported directly by `karaoke_presenter`, `karaoke_page`,
  the score/playhead, and the waveform pipeline.
- Mic + devices go through the `AudioIoBackend` seam
  (`frontend/src/audio_devices/`), today only `WebAudioBackend` (getUserMedia +
  monitor nodes on the shared `AudioContext`; `setSinkId`; master-gain volume).
- The Tauri Rust core (`src-tauri/src/`) already has the IPC patterns we need:
  desktop-only modules behind `#[cfg(desktop)]`, commands registered via
  `invoke_handler(generate_handler![...])`, streaming telemetry via a Tauri
  `Channel` (see the sidecar broker + `frontend/src/net/sidecar_transport.ts`),
  and a temp-file handoff to a separate process under `$TEMP/utai/**` (the one
  fs-scoped writable dir).
- Time-stretch (the Signalsmith Stretch worklet) is a Drumjot carryover and is
  **being removed entirely**; no build needs pitch-preserving speed change.

## Scope

**In (Sub-project A):**
- Remove the Signalsmith stretch worklet; the web player becomes plain
  `AudioBufferSourceNode` playback (still 1×, gapless seek via reschedule).
- Extract a `PlaybackEngine` interface; `JotPlayer` (renamed) is the Web Audio
  implementation.
- Rust audio engine (`src-tauri/src/audio/`): decode + play the backing track,
  capture the mic, mix monitor + track, output through one cpal device;
  input/output device enumeration + selection; per-channel volume/mute; input
  level metering; transport (play/pause/seek/stop) with position telemetry.
- `NativeAudioEngine` (TS facade over Rust IPC) implementing `PlaybackEngine`,
  and a `NativeAudioBackend` implementing `AudioIoBackend`. Selected on desktop.
- Jot → Utai rename across the playback/transport layer.

**Out (Sub-project B and later):**
- ASIO feature + WASAPI exclusive mode; buffer-size / backend-selection UI;
  measured-latency reporting; xrun handling + ASIO→WASAPI fallback. (The cpal
  `asio` feature is left unconfigured here; the code compiles without it.)
- Any web-build behavior change beyond removing the stretch worklet.
- Effects (reverb/EQ) on the monitor path.

## Architecture

Three layers; the platform swap is at the engine boundary.

```
                     ┌──────────────── frontend (TS, both builds) ───────────────┐
  file / download →  │  Track layer: decode → AudioBuffer (waveform peaks +      │
                     │  lyrics-alignment sourceBlob).  UNCHANGED, both builds.    │
                     └───────────────────────────────┬───────────────────────────┘
                                                      │
             ┌────────────────────────────────────────┴───────────────────────────┐
             │  playbackEngine: PlaybackEngine        audioBackend: AudioIoBackend  │
             │                                                                      │
   web/android│  JotPlayer→UtaiPlayer (Web Audio)      WebAudioBackend              │
     desktop  │  NativeAudioEngine ───┐               NativeAudioBackend ──┐        │
             └───────────────────────┼──────────────────────────────────── ┼───────┘
                                     │   Tauri invoke + Channel             │
                          ┌──────────┴──────────────────────────────────────┴──────┐
                          │  Rust audio engine  (src-tauri/src/audio, #[cfg(desktop)])│
                          │  symphonia decode · cpal in/out · lock-free mix · meter   │
                          └───────────────────────────────────────────────────────────┘
```

**Platform selection.** A resolved singleton `playbackEngine` (and the audio
backend) is chosen once from `isDesktopApp = isTauri() && !__IS_MOBILE__`
(the existing desktop gate). Desktop → `NativeAudioEngine` / `NativeAudioBackend`
(both facades over the one Rust engine). Web + Android → `UtaiPlayer` /
`WebAudioBackend`. Direct `jotPlayer` imports are replaced by this accessor.

### `PlaybackEngine` interface (TS)

The small transport surface both engines implement (drawn from what `JotPlayer`
already exposes, minus rate/speed):

- observables/getters: `state`, `currentTime`, `durationSec`, `timeline`,
  `cued`, `audioTracks`
- `loadAudioTrack(file, role?) / loadAudioTrackFromUrl(...) / clearAudioTrack(id)`
- `play() / pause() / resume() / stop() / seek(seconds)`

`AudioIoBackend` (already defined) gains `NativeAudioBackend`; on desktop the
same Rust engine backs both, so e.g. `setOutputVolume` and mic monitor are one
implementation.

### Track layer stays shared

`loadAudioTrack` still decodes to an `AudioBuffer` in the frontend, the
**waveform** worker (peaks) and **lyrics alignment** (`sourceBlob` re-upload)
need it on both builds. On desktop it *additionally* hands the encoded bytes to
Rust for playback. The track is therefore decoded twice on desktop (frontend
for visuals, Rust for audio); this is deliberate, it keeps one waveform/
alignment path across builds and avoids shipping ~90 MB of PCM over IPC.

## Rust audio engine (`src-tauri/src/audio/`, `#[cfg(desktop)]`)

Modules (indicative): `mod.rs` (state + command handlers), `engine.rs` (stream
setup + lifecycle), `mixer.rs` (real-time callback math), `decode.rs`
(symphonia), `devices.rs` (cpal enumeration/selection).

**Threads & data:**
- A **cpal output stream** whose callback is the only real-time context: it
  reads track PCM at the current playhead, pulls captured mic frames from an
  input ring, applies gains/mute, writes the device buffer. No locks, no
  allocation in the callback.
- A **cpal input stream** (mic) whose callback pushes frames into a lock-free
  SPSC ring (`rtrb`) consumed by the output callback (monitor) and computes a
  running level (atomic) for metering.
- Track PCM held as `Arc<[f32]>` (interleaved, engine sample rate; resampled at
  decode if needed). Playhead = `AtomicU64` sample index. Volumes/mute/state =
  atomics. The control thread (Tauri commands) only swaps atomics / the track
  `Arc`, never touches the callback's data non-atomically.
- **Decode** with symphonia off-thread on load, then **resample the whole track
  once** to the output-device sample rate with `rubato` (streams run at the
  output rate). The mic input stream is opened at the output rate where the
  device allows, else its frames are resampled as they enter the ring.

**Control (invoke commands):**
`audio_load_track(path)` (reads the temp file, decodes, swaps the track Arc,
returns duration), `audio_play/pause/resume/stop`, `audio_seek(seconds)`,
`audio_list_devices()`, `audio_set_input_device(id)`, `audio_set_output_device(id)`,
`audio_set_mic_gain(g)`, `audio_set_output_volume(v)`. All `#[cfg(desktop)]`,
registered in the existing `invoke_handler`.

**Telemetry (Channel):** one `Channel` opened at engine start streaming
`{ kind: 'position', playSec, atEpochMs }` (a resync anchor, ~10–20 Hz, not
per-frame) and `{ kind: 'level', rms }`. The frontend dead-reckons `currentTime`
between anchors each rAF (`playSec + (now - atEpochMs)` while playing), exactly
like the current Web Audio anchor math, so the 120 fps playhead never awaits
IPC. `stop`/end emits a terminal position.

**Track handoff:** frontend writes encoded bytes to `$TEMP/utai/<id>-<name>`
(reusing `writeTempAudio` from `sidecar_transport`) and passes the path to
`audio_load_track`; Rust reads + decodes. Consistent with the sidecar's existing
path-based contract and its fs scope.

**Android/web:** the whole module is `#[cfg(desktop)]`; mobile + web select the
Web Audio engine. No cpal on Android in Sub-project A.

## Device & volume model

Maps onto the existing `AudioDeviceStore` unchanged: `selectedInputId` /
`selectedOutputId` (`''` = default, `none` = off), `micVolume`/`micMuted`,
`outputVolume`/`outputMuted`, `micLevel`. `NativeAudioBackend` forwards these to
the Rust commands; device lists come from `audio_list_devices`. `None`
input = stop capture; `None` output = silence the output stream. `outputSelectable`
is true on the native backend (device routing is first-class in cpal).

## Jot → Utai rename

Fold the rename into this sub-project (the transport layer is being reshaped
anyway). Via LSP rename to catch every reference: `JotPlayer`→`UtaiPlayer`,
`jotPlayer`→`utaiPlayer`, `JotTimeline`→`UtaiTimeline`, and the "jot time"
transport-clock terms (`startJotTime`/`currentJotTime`→`startPlaySec`/
`playSecAt` or similar). File renames follow (`player.ts` stays; symbol renames
only, no gratuitous file moves). The `window.utai` debug handle already uses the
new name.

## Build / config

New Rust deps (desktop target): `cpal`, `symphonia` (mp3/aac/flac/wav/ogg
features to match `decodeAudioData` coverage), `rtrb` (lock-free ring). The cpal
`asio` feature is **not** enabled in A (needs the Steinberg SDK + Windows; it's
Sub-project B). No new frontend deps. Removing the stretch worklet drops the
Signalsmith worklet asset + `stretch_node.ts` from the bundle.

## Error handling

- Device open / stream-start failure → command returns an error; the
  `NativeAudioBackend` surfaces a toast and leaves the engine idle. Output
  device gone mid-play → engine falls back to the default device and re-emits
  device list (hot-plug via cpal where available; otherwise on next enumerate).
- Decode failure → `audio_load_track` rejects; frontend shows the same
  "could not load" path as today.
- IPC/Channel drop → the frontend stops dead-reckoning and marks the transport
  idle rather than freezing the playhead.
- Underruns (xruns) are logged; robust handling is Sub-project B.

## Testing & verification

- **Here (Linux):** the full web/frontend change, stretch removal, the
  `PlaybackEngine` extraction, the rename, is verified with
  `typecheck`/`test`/`lint`/`build`/`e2e` (web build unaffected → e2e stays
  green). Rust compiles against cpal's ALSA backend (`cargo check`); pure mixer/
  ring/transport logic gets `cargo test` (no device needed).
- **User (Windows + ASIO interface):** actual desktop audio, track playback,
  device selection, mic monitor, latency feel, validated on buildable
  checkpoints, feeding back. ASIO itself is exercised in Sub-project B.
- e2e can't drive native audio; the desktop engine is validated manually +
  by Rust unit tests, not Playwright.

## Implementation order (high level; steps land in the plan)

1. Remove stretch worklet; web player → plain buffer-source. (verify: build+e2e)
2. Extract `PlaybackEngine`; introduce the resolved `playbackEngine` accessor;
   migrate `jotPlayer` call sites. Jot→Utai rename. (verify: build+e2e)
3. Rust engine skeleton: cpal **output** + symphonia decode + transport +
   position Channel; `audio_load_track/play/pause/seek/stop`. (verify: cargo
   check/test here; user plays a track on Windows)
4. `NativeAudioEngine` facade + platform selection; desktop plays via Rust.
5. Rust **input** + monitor mix + level; device enumeration/selection;
   `NativeAudioBackend`. (verify: user hears mic monitor on Windows)
6. Volume/mute wiring end-to-end; error/hot-plug handling; polish.

## Risks / open questions

- **cpal WASAPI is shared-mode**; latency is better than the browser but not
  ASIO-grade until Sub-project B. Set expectations accordingly.
- **`invoke` byte transfer** vs temp-file: spec assumes temp-file handoff
  (proven here); revisit if it proves clumsy.
- **Playhead accuracy** under dead-reckoning across pause/seek, mirror the
  existing anchor reset logic carefully to avoid drift at transport edges.
