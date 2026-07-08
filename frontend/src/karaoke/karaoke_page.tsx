import { observer } from 'mobx-react-lite';
import { autorun } from 'mobx';
import { FolderOpen, Music, Pause, Play, Save, Search, Settings, Square } from 'lucide-react';
import React from 'react';
import { nativeAudioEngine, playbackEngine } from 'src/editing/playback/player';
import { lyricsStore } from 'src/lyrics/store';
import { activeLineIndexAt } from 'src/lyrics/lrc';
import { formatPlayheadTime } from 'src/editing/playback/playhead_label';
import { AudioTrackView } from 'src/editing/mixer/audio_track_view';
import { LyricsTrackView } from 'src/editing/lyrics/lyrics_track_view';
import { LyricsSearchModal } from 'src/editing/lyrics/lyrics_search_modal';
import { LyricsTextLoadModal } from 'src/editing/lyrics/lyrics_text_modal';
import { LyricsPresenter } from 'src/editing/lyrics/lyrics_presenter';
import { LyricsAlignStore } from 'src/editing/lyrics/lyrics_align_store';
import {
  LyricsAlignStoreContext,
  LyricsPresenterContext,
} from 'src/editing/lyrics/lyrics_contexts';
import { StructuralPresenter } from 'src/editing/structure/structural_presenter';
import { StructuralContext } from 'src/editing/editor_contexts';
import { ViewportStore } from 'src/editing/viewport/viewport_store';
import { ViewportStoreContext } from 'src/editing/viewport/viewport_contexts';
import { ViewConfig } from 'src/editing/viewport/view_config';
import { ToastContainer } from 'src/ui/toasts/toast_container';
import { MusicSearchModal } from 'src/music_source/music_search_modal';
import {
  MusicSourcePresenterContext,
  MusicSourceStoreContext,
} from 'src/music_source/music_source_contexts';
import { MusicSourcePresenter } from 'src/music_source/music_source_presenter';
import { MusicSourceStore } from 'src/music_source/music_source_store';
import { isTauri } from '@tauri-apps/api/core';
import { AudioDeviceStore } from 'src/audio_devices/audio_device_store';
import { AudioDevicePresenter } from 'src/audio_devices/audio_device_presenter';
import { NONE_DEVICE_ID } from 'src/audio_devices/audio_io_backend';
import { WebAudioBackend } from 'src/audio_devices/web_audio_backend';
import { NativeAudioBackend } from 'src/audio_devices/native_audio_backend';
import {
  AudioDevicePresenterContext,
  AudioDeviceStoreContext,
} from 'src/audio_devices/audio_device_contexts';
import { HomeAudioControls } from 'src/audio_devices/audio_controls';
import { SettingsModal } from 'src/settings/settings_modal';
import { useSettingsModal } from 'src/settings/settings_modal_context';
import { ScoringStore } from 'src/scoring/scoring_store';
import { ScoringPresenter, type ScoringClock } from 'src/scoring/scoring_presenter';
import { createLivePitchSource } from 'src/scoring/create_live_pitch_source';
import { firstPitchedTrack, referenceTargets } from 'src/scoring/reference_targets';
import { ScoringPresenterContext, ScoringStoreContext } from 'src/scoring/scoring_contexts';
import { ScoringControls } from 'src/scoring/scoring_hud';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { AutoscrollMode } from 'src/settings/app_settings_store';
import { autoscrollTargetLeft } from 'src/editing/score/autoscroll';
import { KaraokePresenter } from './karaoke_presenter';
import {
  KaraokePresenterContext,
  SongIoPresenterContext,
  SongStoreContext,
} from './karaoke_contexts';
import { SongStore } from './song_store';
import { SongIoPresenter } from './song_io_presenter';
import { SongDetailsModal } from './song_details_modal';
import styles from './karaoke_page.module.css';

/** Peer stores + presenters, constructed once at the view root and passed
 *  down independently via React contexts (never a single aggregate store). */
type Session = {
  song: SongStore;
  viewport: ViewportStore;
  structural: StructuralPresenter;
  lyricsAlign: LyricsAlignStore;
  lyricsPresenter: LyricsPresenter;
  presenter: KaraokePresenter;
  songIo: SongIoPresenter;
  musicSource: MusicSourceStore;
  musicPresenter: MusicSourcePresenter;
  audioDevice: AudioDeviceStore;
  audioDevicePresenter: AudioDevicePresenter;
  scoring: ScoringStore;
  scoringPresenter: ScoringPresenter;
};

function buildSession(): Session {
  const song = new SongStore();
  const viewport = new ViewportStore();
  const viewConfig = new ViewConfig();
  const structural = new StructuralPresenter(song, viewport, viewConfig);
  const lyricsAlign = new LyricsAlignStore();
  const presenter = new KaraokePresenter(song, viewport);
  const lyricsPresenter = new LyricsPresenter(lyricsAlign, (meta) => presenter.captureSongMeta(meta));
  const songIo = new SongIoPresenter(song, presenter, lyricsPresenter);
  const musicSource = new MusicSourceStore();
  const musicPresenter = new MusicSourcePresenter(musicSource, (file, meta) =>
    songIo.loadMix(file, meta),
  );
  // Desktop app defaults the mic to the system device; web + mobile default to
  // None so the browser never prompts for the mic on load (the user opts in).
  const isDesktopApp = isTauri() && !__IS_MOBILE__;
  const audioDevice = new AudioDeviceStore(isDesktopApp ? '' : NONE_DEVICE_ID);
  // Desktop routes the mic/device backend to the one native engine; web uses
  // the Web Audio backend.
  const audioBackend = nativeAudioEngine
    ? new NativeAudioBackend(nativeAudioEngine)
    : new WebAudioBackend();
  const audioDevicePresenter = new AudioDevicePresenter(audioDevice, audioBackend);
  const scoring = new ScoringStore();
  const scoringClock: ScoringClock = {
    get currentTime() {
      return playbackEngine.currentTime;
    },
    get isPlaying() {
      return playbackEngine.state === 'playing';
    },
  };
  const scoringPresenter = new ScoringPresenter(scoring, createLivePitchSource(), scoringClock, () =>
    referenceTargets(firstPitchedTrack(lyricsStore)),
  );
  return {
    song,
    viewport,
    structural,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
  };
}

export const KaraokePage = observer(function KaraokePage() {
  const [session] = React.useState(buildSession);
  const {
    song,
    viewport,
    structural,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
  } = session;

  // Open the native engine's telemetry stream on desktop (no-op on web).
  React.useEffect(() => {
    nativeAudioEngine?.init();
    return () => nativeAudioEngine?.dispose();
  }, []);

  // Boot the audio-device layer (enumerate, restore prefs, resume a saved
  // monitor) once, and release the mic on unmount.
  React.useEffect(() => {
    void audioDevicePresenter.init();
    return () => audioDevicePresenter.dispose();
  }, [audioDevicePresenter]);

  // Expose the live session on `window.utai` for e2e specs + debugging.
  React.useEffect(() => {
    (window as Window & { utai?: Record<string, unknown> }).utai = {
      song,
      viewport,
      structural,
      lyricsAlign,
      lyricsPresenter,
      presenter,
      songIo,
      musicSource,
      musicPresenter,
      audioDevice,
      audioDevicePresenter,
      scoring,
      scoringPresenter,
      lyricsStore,
      playbackEngine,
    };
  }, [
    song,
    viewport,
    structural,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
  ]);

  return (
    <KaraokePresenterContext.Provider value={presenter}>
      <MusicSourceStoreContext.Provider value={musicSource}>
      <MusicSourcePresenterContext.Provider value={musicPresenter}>
      <AudioDeviceStoreContext.Provider value={audioDevice}>
      <AudioDevicePresenterContext.Provider value={audioDevicePresenter}>
      <ScoringStoreContext.Provider value={scoring}>
      <ScoringPresenterContext.Provider value={scoringPresenter}>
      <SongStoreContext.Provider value={song}>
      <SongIoPresenterContext.Provider value={songIo}>
        <StructuralContext.Provider value={structural}>
          <ViewportStoreContext.Provider value={viewport}>
            <LyricsPresenterContext.Provider value={lyricsPresenter}>
              <LyricsAlignStoreContext.Provider value={lyricsAlign}>
                <div className={styles.page}>
                  <Toolbar />
                  <ScoreArea />
                  <TransportBar />
                  <Modals />
                  <ToastContainer />
                </div>
              </LyricsAlignStoreContext.Provider>
            </LyricsPresenterContext.Provider>
          </ViewportStoreContext.Provider>
        </StructuralContext.Provider>
      </SongIoPresenterContext.Provider>
      </SongStoreContext.Provider>
      </ScoringPresenterContext.Provider>
      </ScoringStoreContext.Provider>
      </AudioDevicePresenterContext.Provider>
      </AudioDeviceStoreContext.Provider>
      </MusicSourcePresenterContext.Provider>
      </MusicSourceStoreContext.Provider>
    </KaraokePresenterContext.Provider>
  );
});

const Toolbar = observer(function Toolbar() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const lyricsPresenter = React.useContext(LyricsPresenterContext)!;
  const musicPresenter = React.useContext(MusicSourcePresenterContext)!;
  const songIo = React.useContext(SongIoPresenterContext)!;
  const viewport = React.useContext(ViewportStoreContext)!;
  const settingsModal = useSettingsModal();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const openSongRef = React.useRef<HTMLInputElement>(null);

  const onPickAudio = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void songIo.loadMix(file);
  };

  const onPickSong = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void songIo.loadBundleFile(file);
  };

  const saveLabel = songIo.phase === 'packing' ? 'Saving…' : 'Save song';

  const firstLyricsId = lyricsStore.trackIds[0];
  const canAlign = firstLyricsId !== undefined && playbackEngine.audioTracks.size > 0;

  return (
    <header className={styles.toolbar}>
      <button type="button" className={styles.toolButton} onClick={() => fileRef.current?.click()} data-testid="load-audio">
        Load audio
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        className={styles.hiddenInput}
        onChange={onPickAudio}
      />
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => musicPresenter.openSearch()}
        data-testid="music-search-open"
      >
        <Music size={14} aria-hidden="true" /> Add from streaming
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => lyricsPresenter.setLyricsSearchOpen(true)}
        data-testid="import-lyrics"
      >
        <Search size={14} aria-hidden="true" /> Import lyrics
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => lyricsPresenter.setLyricsTextOpen(true)}
        data-testid="paste-lyrics"
      >
        Paste lyrics
      </button>
      <button
        type="button"
        className={styles.toolButton}
        disabled={!canAlign}
        onClick={() => firstLyricsId && lyricsPresenter.alignTrackToVocals(firstLyricsId)}
        title={canAlign ? 'Align lyrics to the vocals' : 'Load an audio track and lyrics first'}
        data-testid="align-vocals"
      >
        Align to vocals
      </button>
      <span className={styles.toolbarSpacer} />
      {songIo.phase === 'separating' && (
        <span className={styles.toolStatus} data-testid="separating-status">
          Separating stems…
        </span>
      )}
      <button
        type="button"
        className={styles.toolButton}
        disabled={!songIo.canSave || songIo.busy}
        onClick={() => void songIo.saveSong()}
        title="Save the stems, lyrics, and details as a song bundle (.zip)"
        data-testid="save-song"
      >
        <Save size={14} aria-hidden="true" /> {saveLabel}
      </button>
      <button
        type="button"
        className={styles.toolButton}
        disabled={songIo.busy}
        onClick={() => openSongRef.current?.click()}
        title="Open a saved song bundle (.zip)"
        data-testid="open-song"
      >
        <FolderOpen size={14} aria-hidden="true" /> Open song
      </button>
      <input
        ref={openSongRef}
        type="file"
        accept=".zip,application/zip"
        className={styles.hiddenInput}
        onChange={onPickSong}
      />
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => songIo.openDetails()}
        title="Edit song title, artist, and links"
        data-testid="song-details-open"
      >
        Details
      </button>
      <button
        type="button"
        className={styles.toolButton}
        onClick={() => settingsModal.openSettings()}
        aria-label="Settings"
        title="Settings"
        data-testid="settings-open"
      >
        <Settings size={14} aria-hidden="true" />
      </button>
      <label className={styles.zoomControl}>
        Zoom
        <input
          type="range"
          min={8}
          max={600}
          step={1}
          value={viewport.pxPerBeat}
          onChange={(e) => presenter.setZoom(Number(e.target.value))}
          aria-label="Horizontal zoom (pixels per second)"
        />
      </label>
    </header>
  );
});

const ScoreArea = observer(function ScoreArea() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const viewport = React.useContext(ViewportStoreContext)!;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const audioTrackIds = Array.from(playbackEngine.audioTracks.keys());
  const lyricsIds = lyricsStore.trackIds;
  const hasContent = audioTrackIds.length > 0 || lyricsIds.length > 0;

  // Feed the viewport width from a ResizeObserver (never read layout in a
  // hot path; this fires only on resize).
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => presenter.setViewportWidth(el.clientWidth));
    ro.observe(el);
    presenter.setViewportWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [presenter]);

  // Playhead position writer: mirror the transport's currentTime × zoom
  // onto the `--playhead-x` var each frame it changes. Runs off the MobX
  // observable graph (autorun), not a raw rAF, so it quiesces when idle.
  React.useEffect(() => {
    return autorun(() => {
      const x = playbackEngine.currentTime * viewport.pxPerBeat;
      const nodes = document.querySelectorAll<HTMLElement>('[data-playhead="1"]');
      for (const n of nodes) n.style.setProperty('--playhead-x', `${x}px`);
    });
  }, [viewport]);

  // Autoscroll (follow-playhead): drive the score's scrollLeft so the playhead
  // stays centred (`center`), paged (`page`), or the current lyric line stays
  // in view (`line`). Reads `mode` first, so an `off` mode never subscribes to
  // `currentTime` and the autorun stays idle. Programmatic scrollLeft re-fires
  // the onScroll → setScrollX mirror (harmless; it just keeps the windowing
  // store in sync).
  React.useEffect(() => {
    return autorun(() => {
      const mode = appSettingsStore.autoscrollMode;
      if (mode === 'off') return;
      const el = scrollRef.current;
      if (!el) return;
      const ppb = viewport.pxPerBeat;
      if (ppb <= 0) return;

      // Line mode pages on the original lyric-line boundaries, pinning the
      // current line's start to the left of the bars area. Driven off the
      // first lyrics track; positions regardless of play state so the single
      // visible line (see WindowedLines) is always scrolled into view.
      if (mode === 'line') {
        const trackId = lyricsStore.trackIds[0];
        const track = trackId != null ? lyricsStore.get(trackId) : undefined;
        if (!track || track.lines.length === 0) return;
        const audioTime = playbackEngine.currentTime - playbackEngine.songLeadInSec;
        const idx = activeLineIndexAt(track.lines, audioTime, track.offsetSec) ?? 0;
        el.scrollLeft = Math.max(0, (track.lines[idx].startSec + track.offsetSec) * ppb);
        return;
      }

      if (playbackEngine.state !== 'playing') return;
      const vw = viewport._viewportWidth;
      if (vw <= 0) return;
      const playheadX = playbackEngine.currentTime * ppb;
      el.scrollLeft = autoscrollTargetLeft(mode, playheadX, vw);
    });
  }, [viewport]);

  const onSeek = (x: number): void => presenter.seekToX(x);

  return (
    <div
      className={styles.scoreArea}
      ref={scrollRef}
      onScroll={(e) => presenter.setScrollX(e.currentTarget.scrollLeft)}
      data-testid="score-area"
    >
      {!hasContent && (
        <div className={styles.emptyState} data-testid="empty-state">
          Load an audio file, then import or paste lyrics.
        </div>
      )}
      {audioTrackIds.map((id) => {
        const track = playbackEngine.audioTracks.get(id);
        return track ? <AudioTrackView key={id} track={track} onSeek={onSeek} /> : null;
      })}
      {lyricsIds.map((id) => (
        <LyricsTrackView key={id} id={id} onSeek={onSeek} />
      ))}
    </div>
  );
});

const TransportBar = observer(function TransportBar() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const song = React.useContext(SongStoreContext)!;
  const playing = playbackEngine.state === 'playing';
  const canPlay = song.durationSec > 0;
  return (
    <footer className={styles.transport}>
      <button
        type="button"
        className={styles.transportButton}
        disabled={!canPlay}
        onClick={() => presenter.togglePlay()}
        aria-label={playing ? 'Pause' : 'Play'}
        data-testid="transport-play"
      >
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={styles.transportButton}
        disabled={playbackEngine.state === 'idle'}
        onClick={() => presenter.stop()}
        aria-label="Stop"
        data-testid="transport-stop"
      >
        <Square size={16} aria-hidden="true" />
      </button>
      <span className={styles.transportTime} data-testid="transport-time">
        {formatPlayheadTime(playbackEngine.currentTime)}
        {song.durationSec > 0 ? ` / ${formatPlayheadTime(song.durationSec)}` : ''}
      </span>
      <AutoscrollControl />
      <ScoringControls />
      <HomeAudioControls />
    </footer>
  );
});

const AUTOSCROLL_LABELS: Record<AutoscrollMode, string> = {
  off: "Don't follow",
  center: 'Center',
  page: 'Page',
  line: 'Line',
};

const AutoscrollControl = observer(function AutoscrollControl() {
  return (
    <label className={styles.followControl}>
      Follow
      <select
        className={styles.followSelect}
        value={appSettingsStore.autoscrollMode}
        onChange={(e) => appSettingsPresenter.setAutoscrollMode(e.target.value as AutoscrollMode)}
        aria-label="Autoscroll to follow the playhead during playback"
        title="How the score scrolls to follow the playhead while playing"
        data-testid="autoscroll-mode"
      >
        {(Object.keys(AUTOSCROLL_LABELS) as AutoscrollMode[]).map((mode) => (
          <option key={mode} value={mode}>
            {AUTOSCROLL_LABELS[mode]}
          </option>
        ))}
      </select>
    </label>
  );
});

const Modals = observer(function Modals() {
  const lyricsPresenter = React.useContext(LyricsPresenterContext)!;
  const lyricsAlign = React.useContext(LyricsAlignStoreContext)!;
  return (
    <>
      <LyricsSearchModal
        open={lyricsAlign.lyricsSearchOpen}
        initialTitle=""
        initialArtist=""
        onClose={() => lyricsPresenter.setLyricsSearchOpen(false)}
        presenter={lyricsPresenter}
      />
      <LyricsTextLoadModal
        open={lyricsAlign.lyricsTextOpen}
        onClose={() => lyricsPresenter.setLyricsTextOpen(false)}
        presenter={lyricsPresenter}
      />
      <MusicSearchModal />
      <SettingsModal />
      <SongDetailsModal />
    </>
  );
});

