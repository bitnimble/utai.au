import { observer } from 'mobx-react-lite';
import { autorun } from 'mobx';
import { Music, Pause, Play, Search, Settings, Square } from 'lucide-react';
import React from 'react';
import { nativeAudioEngine, playbackEngine } from 'src/editing/playback/player';
import { lyricsStore } from 'src/lyrics/store';
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
import { KaraokePresenter } from './karaoke_presenter';
import { KaraokePresenterContext, SongStoreContext } from './karaoke_contexts';
import { SongStore } from './song_store';
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
  musicSource: MusicSourceStore;
  musicPresenter: MusicSourcePresenter;
  audioDevice: AudioDeviceStore;
  audioDevicePresenter: AudioDevicePresenter;
};

function buildSession(): Session {
  const song = new SongStore();
  const viewport = new ViewportStore();
  const viewConfig = new ViewConfig();
  const structural = new StructuralPresenter(song, viewport, viewConfig);
  const lyricsAlign = new LyricsAlignStore();
  const lyricsPresenter = new LyricsPresenter(lyricsAlign);
  const presenter = new KaraokePresenter(song, viewport);
  const musicSource = new MusicSourceStore();
  const musicPresenter = new MusicSourcePresenter(musicSource, (file) =>
    presenter.loadAudioFile(file),
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
  return {
    song,
    viewport,
    structural,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
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
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
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
      musicSource,
      musicPresenter,
      audioDevice,
      audioDevicePresenter,
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
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
  ]);

  return (
    <KaraokePresenterContext.Provider value={presenter}>
      <MusicSourceStoreContext.Provider value={musicSource}>
      <MusicSourcePresenterContext.Provider value={musicPresenter}>
      <AudioDeviceStoreContext.Provider value={audioDevice}>
      <AudioDevicePresenterContext.Provider value={audioDevicePresenter}>
      <SongStoreContext.Provider value={song}>
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
      </SongStoreContext.Provider>
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
  const viewport = React.useContext(ViewportStoreContext)!;
  const settingsModal = useSettingsModal();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const onPickAudio = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void presenter.loadAudioFile(file);
  };

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
      <HomeAudioControls />
    </footer>
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
    </>
  );
});

