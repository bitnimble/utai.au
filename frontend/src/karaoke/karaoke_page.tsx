import { isTauri } from '@tauri-apps/api/core';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { autorun } from 'mobx';
import { ChevronDown, Maximize, Minimize, Pause, Play, Settings, Square } from 'lucide-react';
import React from 'react';
import { MAX_SPEED, MIN_SPEED } from 'src/editing/playback/playback_engine';
import { nativeAudioOutput, playbackEngine } from 'src/editing/playback/player';
import { lyricsStore } from 'src/lyrics/store';
import { activeLineIndexAt, lineSpanSec } from 'src/lyrics/lrc';
import { formatPlayheadTime } from 'src/editing/playback/playhead_label';
import { AudioTrackView } from 'src/editing/mixer/audio_track_view';
import { StemMixControls } from 'src/editing/mixer/stem_mix_controls';
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
import { BeatStore } from 'src/editing/beats/beat_store';
import { BeatStoreContext } from 'src/editing/beats/beat_contexts';
import { formatBeatSummary } from 'src/editing/beats/beat_analysis';
import {
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ViewportStore,
} from 'src/editing/viewport/viewport_store';
import { ViewportStoreContext } from 'src/editing/viewport/viewport_contexts';
import { ViewConfig } from 'src/editing/viewport/view_config';
import { ToastContainer } from 'src/ui/toasts/toast_container';
import { UpdateButton } from 'src/updates/update_button';
import {
  ActionMenuItem,
  DropdownButton,
  DropdownSection,
  SubmenuItem,
  ToggleMenuItem,
} from 'src/ui/dropdown/dropdown';
import { Slider } from 'src/ui/slider/slider';
import { NumberStepper } from 'src/ui/number_stepper/number_stepper';
import {
  MusicSourcePresenterContext,
  MusicSourceStoreContext,
} from 'src/music_source/music_source_contexts';
import { MusicSourcePresenter } from 'src/music_source/music_source_presenter';
import { MusicSourceStore } from 'src/music_source/music_source_store';
import { AudioDeviceStore } from 'src/audio_devices/audio_device_store';
import { AudioDevicePresenter, MAX_AUDIO_OFFSET_MS } from 'src/audio_devices/audio_device_presenter';
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
import {
  AutoscrollMode,
  MAX_LYRIC_FONT_SIZE_PX,
  MIN_LYRIC_FONT_SIZE_PX,
  ViewMode,
} from 'src/settings/app_settings_store';
import { autoscrollTargetLeft, GUTTER_PX } from 'src/editing/score/autoscroll';
import { VideoStore } from 'src/video/video_store';
import { VideoPresenter } from 'src/video/video_presenter';
import { VideoPresenterContext, VideoStoreContext } from 'src/video/video_contexts';
import { VideoArea } from 'src/video/video_area';
import { SkipSegmentsStore } from 'src/skip_segments/skip_segments_store';
import { SkipSegmentsPresenter } from 'src/skip_segments/skip_segments_presenter';
import {
  SkipSegmentsPresenterContext,
  SkipSegmentsStoreContext,
} from 'src/skip_segments/skip_segments_contexts';
import { SkipSegmentButton } from 'src/skip_segments/skip_segment_button';
import { prepareSong } from 'src/queue/prepare_song';
import { identifyTrack } from 'src/song_identity/identify_track';
import { QueueStore } from 'src/queue/queue_store';
import { QueuePresenter } from 'src/queue/queue_presenter';
import { QueuePresenterContext, QueueStoreContext } from 'src/queue/queue_contexts';
import { QueueButtons, QueueLoadingScreen, QueueSidebar } from 'src/queue/queue_view';
import { NowPlayingBanner } from 'src/queue/now_playing_banner';
import { downloadTrack, searchTracks } from 'src/net/music_source_client';
import { BackendStartingScreen } from 'src/session/backend_starting_screen';
import type { HostSession } from 'src/session/session_client';
import { SessionHostPresenterContext, SessionHostStoreContext } from 'src/session/session_host_contexts';
import { SessionHostPresenter } from 'src/session/session_host_presenter';
import { SessionHostStore } from 'src/session/session_host_store';
import { SessionHostButton, SessionJoinModal } from 'src/session/session_host_view';
import { FullscreenStore } from 'src/fullscreen/fullscreen_store';
import { FullscreenPresenter } from 'src/fullscreen/fullscreen_presenter';
import { fullscreenDriver } from 'src/fullscreen/fullscreen_driver';
import { FullscreenPresenterContext, FullscreenStoreContext } from 'src/fullscreen/fullscreen_contexts';
import { KaraokePresenter } from './karaoke_presenter';
import {
  KaraokePresenterContext,
  SongIoPresenterContext,
  SongStoreContext,
} from './karaoke_contexts';
import { SongStore } from './song_store';
import { SongIoPresenter } from './song_io_presenter';
import { SongDetailsModal } from './song_details_modal';
import { KaraokeLyricsOverlay } from './karaoke_lyrics_overlay';
import styles from './karaoke_page.module.css';

const MEDIA_SEEK_STEP_SEC = 10;
const MEDIA_SEEK_REPEAT_MS = 250;
const REPEATING_MEDIA_KEYS = new Set(['MediaFastForward', 'MediaRewind']);

/** Peer stores + presenters, constructed once at the view root and passed
 *  down independently via React contexts (never a single aggregate store). */
type Session = {
  song: SongStore;
  viewport: ViewportStore;
  structural: StructuralPresenter;
  beats: BeatStore;
  lyricsAlign: LyricsAlignStore;
  lyricsPresenter: LyricsPresenter;
  presenter: KaraokePresenter;
  songIo: SongIoPresenter;
  queue: QueueStore;
  queuePresenter: QueuePresenter;
  musicSource: MusicSourceStore;
  musicPresenter: MusicSourcePresenter;
  audioDevice: AudioDeviceStore;
  audioDevicePresenter: AudioDevicePresenter;
  scoring: ScoringStore;
  scoringPresenter: ScoringPresenter;
  videoStore: VideoStore;
  videoPresenter: VideoPresenter;
  skipSegments: SkipSegmentsStore;
  skipSegmentsPresenter: SkipSegmentsPresenter;
  fullscreen: FullscreenStore;
  fullscreenPresenter: FullscreenPresenter;
};

type SessionHost = { sessionHost: SessionHostStore; sessionHostPresenter: SessionHostPresenter };

function buildSession(): Session {
  const song = new SongStore();
  const viewport = new ViewportStore();
  const viewConfig = new ViewConfig();
  const structural = new StructuralPresenter(song, viewport, viewConfig);
  const beats = new BeatStore();
  const lyricsAlign = new LyricsAlignStore();
  const presenter = new KaraokePresenter(song, viewport);
  const skipSegments = new SkipSegmentsStore(song, playbackEngine);
  const lyricsPresenter = new LyricsPresenter(lyricsAlign, skipSegments, (meta) => presenter.captureSongMeta(meta));
  const videoStore = new VideoStore(song);
  const videoPresenter = new VideoPresenter(videoStore);
  const skipSegmentsPresenter = new SkipSegmentsPresenter(skipSegments, videoStore, playbackEngine);
  const songIo = new SongIoPresenter(song, presenter, lyricsPresenter, beats, videoPresenter, skipSegmentsPresenter);
  const queue = new QueueStore();
  const queuePresenter = new QueuePresenter(queue, songIo, playbackEngine, prepareSong, identifyTrack, downloadTrack);
  const musicSource = new MusicSourceStore();
  const musicPresenter = new MusicSourcePresenter(musicSource, (track) =>
    queuePresenter.add({ kind: 'streaming', track }),
  );
  const audioDevice = new AudioDeviceStore();
  const audioBackend = nativeAudioOutput
    ? new NativeAudioBackend(nativeAudioOutput)
    : new WebAudioBackend();
  const audioDevicePresenter = new AudioDevicePresenter(audioDevice, audioBackend, playbackEngine);
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
  const fullscreen = new FullscreenStore(appSettingsStore);
  const fullscreenPresenter = new FullscreenPresenter(fullscreen, fullscreenDriver(), queuePresenter);
  return {
    song,
    viewport,
    structural,
    beats,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    queue,
    queuePresenter,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
    videoStore,
    videoPresenter,
    skipSegments,
    skipSegmentsPresenter,
    fullscreen,
    fullscreenPresenter,
  };
}

function buildSessionHost(hostSession: HostSession, session: Session): SessionHost {
  const sessionHost = new SessionHostStore(hostSession, appSettingsStore, isTauri() ? undefined : window.location.origin);
  const sessionHostPresenter = new SessionHostPresenter(sessionHost, {
    queue: session.queue,
    queuePresenter: session.queuePresenter,
    song: session.song,
    karaoke: session.presenter,
    transport: playbackEngine,
    audioDevice: session.audioDevice,
    audioDevicePresenter: session.audioDevicePresenter,
    searchTracks,
  });
  return { sessionHost, sessionHostPresenter };
}

export const KaraokePage = observer(function KaraokePage({ hostSession }: { hostSession?: HostSession }) {
  const [session] = React.useState(buildSession);
  const host = React.useMemo(() => hostSession && buildSessionHost(hostSession, session), [hostSession, session]);
  const sessionHost = host?.sessionHost;
  const sessionHostPresenter = host?.sessionHostPresenter;
  const {
    song,
    viewport,
    structural,
    beats,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    queue,
    queuePresenter,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
    videoStore,
    videoPresenter,
    skipSegments,
    skipSegmentsPresenter,
    fullscreen,
    fullscreenPresenter,
  } = session;

  // Open the native engine's telemetry stream on desktop (no-op on web).
  React.useEffect(() => {
    nativeAudioOutput?.init();
    return () => nativeAudioOutput?.dispose();
  }, []);

  // Boot the audio-device layer (enumerate, restore prefs, resume a saved
  // monitor) once, and release the mic on unmount.
  React.useEffect(() => {
    void audioDevicePresenter.init();
    return () => audioDevicePresenter.dispose();
  }, [audioDevicePresenter]);

  React.useEffect(() => {
    presenter.start();
    return () => presenter.dispose();
  }, [presenter]);

  React.useEffect(() => {
    skipSegmentsPresenter.start();
    return () => skipSegmentsPresenter.dispose();
  }, [skipSegmentsPresenter]);

  React.useEffect(() => {
    fullscreenPresenter.start();
    return () => fullscreenPresenter.dispose();
  }, [fullscreenPresenter]);

  React.useEffect(() => {
    queuePresenter.init();
    return () => queuePresenter.dispose();
  }, [queuePresenter]);

  React.useEffect(() => {
    sessionHostPresenter?.start();
    return () => sessionHostPresenter?.dispose();
  }, [sessionHostPresenter]);

  // Global spacebar transport toggle. Ignored while typing into a form field
  // or contenteditable so the space still types a character there.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typesText = tag === 'INPUT' && !(t instanceof HTMLInputElement && t.type === 'range');
      if (typesText || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      e.preventDefault();
      presenter.togglePlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [presenter]);

  React.useEffect(() => {
    const actions: Partial<Record<string, () => void>> = {
      MediaPlayPause: () => presenter.togglePlay(),
      MediaPlay: () => presenter.play(),
      MediaPause: () => presenter.pause(),
      MediaStop: () => presenter.stop(),
      MediaTrackNext: () => queuePresenter.skip(),
      MediaTrackPrevious: () => presenter.seek(0),
      MediaFastForward: () => presenter.seekBy(MEDIA_SEEK_STEP_SEC),
      MediaRewind: () => presenter.seekBy(-MEDIA_SEEK_STEP_SEC),
    };
    let lastRepeatMs = -Infinity;
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = actions[e.key];
      if (action == null) return;
      e.preventDefault();
      if (e.repeat) {
        if (!REPEATING_MEDIA_KEYS.has(e.key) || e.timeStamp - lastRepeatMs < MEDIA_SEEK_REPEAT_MS) return;
        lastRepeatMs = e.timeStamp;
      }
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [presenter, queuePresenter]);

  // Expose the live session on `window.utai` for e2e specs + debugging.
  React.useEffect(() => {
    (window as Window & { utai?: Record<string, unknown> }).utai = {
      song,
      viewport,
      structural,
      beats,
      lyricsAlign,
      lyricsPresenter,
      presenter,
      songIo,
      queue,
      queuePresenter,
      musicSource,
      musicPresenter,
      audioDevice,
      audioDevicePresenter,
      scoring,
      scoringPresenter,
      videoStore,
      videoPresenter,
      skipSegments,
      skipSegmentsPresenter,
      fullscreen,
      fullscreenPresenter,
      sessionHost,
      sessionHostPresenter,
      lyricsStore,
      playbackEngine,
    };
  }, [
    sessionHost,
    sessionHostPresenter,
    song,
    viewport,
    structural,
    beats,
    lyricsAlign,
    lyricsPresenter,
    presenter,
    songIo,
    queue,
    queuePresenter,
    musicSource,
    musicPresenter,
    audioDevice,
    audioDevicePresenter,
    scoring,
    scoringPresenter,
    videoStore,
    videoPresenter,
    skipSegments,
    skipSegmentsPresenter,
    fullscreen,
    fullscreenPresenter,
  ]);

  const karaokeView = fullscreen.viewMode === 'karaoke';
  return (
    <SessionHostStoreContext.Provider value={sessionHost ?? null}>
    <SessionHostPresenterContext.Provider value={sessionHostPresenter ?? null}>
    <KaraokePresenterContext.Provider value={presenter}>
      <MusicSourceStoreContext.Provider value={musicSource}>
      <MusicSourcePresenterContext.Provider value={musicPresenter}>
      <AudioDeviceStoreContext.Provider value={audioDevice}>
      <AudioDevicePresenterContext.Provider value={audioDevicePresenter}>
      <ScoringStoreContext.Provider value={scoring}>
      <ScoringPresenterContext.Provider value={scoringPresenter}>
      <SongStoreContext.Provider value={song}>
      <SongIoPresenterContext.Provider value={songIo}>
      <QueueStoreContext.Provider value={queue}>
      <QueuePresenterContext.Provider value={queuePresenter}>
        <StructuralContext.Provider value={structural}>
          <ViewportStoreContext.Provider value={viewport}>
            <BeatStoreContext.Provider value={beats}>
            <LyricsPresenterContext.Provider value={lyricsPresenter}>
              <LyricsAlignStoreContext.Provider value={lyricsAlign}>
                <VideoStoreContext.Provider value={videoStore}>
                <VideoPresenterContext.Provider value={videoPresenter}>
                <SkipSegmentsStoreContext.Provider value={skipSegments}>
                <SkipSegmentsPresenterContext.Provider value={skipSegmentsPresenter}>
                <FullscreenStoreContext.Provider value={fullscreen}>
                <FullscreenPresenterContext.Provider value={fullscreenPresenter}>
                <div className={classNames(styles.page, fullscreen.active && styles.fullscreen)}>
                  {appSettingsStore.localBackendPending ? (
                    <BackendStartingScreen />
                  ) : (
                    <>
                      <div className={classNames(styles.chrome, styles.topChrome)}>
                        <Toolbar />
                      </div>
                      <div className={styles.body}>
                        <div className={styles.main}>
                          <VideoArea>
                            {karaokeView && <KaraokeLyricsOverlay />}
                            <NowPlayingBanner />
                            <SkipSegmentButton />
                          </VideoArea>
                          {!karaokeView && <ScoreArea />}
                          <QueueLoadingScreen />
                        </div>
                        <QueueSidebar />
                      </div>
                      <div className={classNames(styles.chrome, styles.bottomChrome)}>
                        {karaokeView && <SeekBar />}
                        <TransportBar />
                      </div>
                    </>
                  )}
                  <Modals />
                  <ToastContainer />
                </div>
                </FullscreenPresenterContext.Provider>
                </FullscreenStoreContext.Provider>
                </SkipSegmentsPresenterContext.Provider>
                </SkipSegmentsStoreContext.Provider>
                </VideoPresenterContext.Provider>
                </VideoStoreContext.Provider>
              </LyricsAlignStoreContext.Provider>
            </LyricsPresenterContext.Provider>
            </BeatStoreContext.Provider>
          </ViewportStoreContext.Provider>
        </StructuralContext.Provider>
      </QueuePresenterContext.Provider>
      </QueueStoreContext.Provider>
      </SongIoPresenterContext.Provider>
      </SongStoreContext.Provider>
      </ScoringPresenterContext.Provider>
      </ScoringStoreContext.Provider>
      </AudioDevicePresenterContext.Provider>
      </AudioDeviceStoreContext.Provider>
      </MusicSourcePresenterContext.Provider>
      </MusicSourceStoreContext.Provider>
    </KaraokePresenterContext.Provider>
    </SessionHostPresenterContext.Provider>
    </SessionHostStoreContext.Provider>
  );
});

const Toolbar = observer(function Toolbar() {
  const lyricsPresenter = React.useContext(LyricsPresenterContext)!;
  const lyricsAlign = React.useContext(LyricsAlignStoreContext)!;
  const songIo = React.useContext(SongIoPresenterContext)!;
  const queuePresenter = React.useContext(QueuePresenterContext)!;
  const beats = React.useContext(BeatStoreContext)!;
  const song = React.useContext(SongStoreContext)!;
  const settingsModal = useSettingsModal();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const openSongRef = React.useRef<HTMLInputElement>(null);

  const onPickAudio = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) queuePresenter.add({ kind: 'file', file });
  };

  const onPickSong = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) queuePresenter.add({ kind: 'bundle', file });
  };

  const saveLabel = songIo.phase === 'packing' ? 'Saving…' : 'Save song';

  const firstLyricsId = lyricsStore.firstTrack?.id;
  const canAlign = firstLyricsId != null && playbackEngine.audioTracks.size > 0;

  return (
    <header className={styles.toolbar}>
      <DropdownButton
        label={<MenuLabel text="File" />}
        className={styles.toolButton}
        title="Open, save, and edit song details"
        testId="file-menu"
      >
        {(close) => (
          <>
            <ActionMenuItem
              label="Load song pack"
              onClick={() => {
                openSongRef.current?.click();
                close();
              }}
              title="Queue a saved song pack (.zip)"
              testId="open-song"
            />
            <ActionMenuItem
              label="Load audio file"
              onClick={() => {
                fileRef.current?.click();
                close();
              }}
              title="Queue a local audio file (auto-separates into stems)"
              testId="load-audio"
            />
            <ActionMenuItem
              label={saveLabel}
              onClick={() => {
                void songIo.saveSong();
                close();
              }}
              disabled={!songIo.canSave || songIo.busy}
              title="Save the stems, lyrics, and details as a song bundle (.zip)"
              testId="save-song"
            />
            <ActionMenuItem
              label="Details"
              onClick={() => {
                songIo.openDetails();
                close();
              }}
              title="Edit song title, artist, and links"
              testId="song-details-open"
            />
          </>
        )}
      </DropdownButton>
      <DropdownButton
        label={<MenuLabel text="Lyrics" />}
        className={styles.toolButton}
        title="Import and align lyrics"
        testId="lyrics-menu"
      >
        {(close) => (
          <>
            <ActionMenuItem
              label="Import lyrics"
              onClick={() => {
                lyricsPresenter.setLyricsSearchOpen(true);
                close();
              }}
              title="Search LRCLIB for synced lyrics"
              testId="import-lyrics"
            />
            <ActionMenuItem
              label="Paste lyrics"
              onClick={() => {
                lyricsPresenter.setLyricsTextOpen(true);
                close();
              }}
              testId="paste-lyrics"
            />
            <ActionMenuItem
              label="Align to vocals"
              onClick={() => {
                if (firstLyricsId) lyricsPresenter.alignTrackToVocals(firstLyricsId);
                close();
              }}
              disabled={!canAlign}
              title={canAlign ? 'Align lyrics to the vocals' : 'Load an audio track and lyrics first'}
              testId="align-vocals"
            />
          </>
        )}
      </DropdownButton>
      <ViewMenu />
      <AudioMenu />
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        className={styles.hiddenInput}
        onChange={onPickAudio}
      />
      <input
        ref={openSongRef}
        type="file"
        accept=".zip,application/zip"
        multiple
        className={styles.hiddenInput}
        onChange={onPickSong}
      />
      {(song.title || song.artist) && (
        <div className={styles.songMeta} data-testid="song-meta">
          {song.title && <span className={styles.songTitle}>{song.title}</span>}
          {song.artist && <span className={styles.songArtist}>{song.artist}</span>}
        </div>
      )}
      <span className={styles.toolbarSpacer} />
      {lyricsAlign.lyricsAlignBusyPhase !== 'idle' && (
        <span className={styles.toolStatus} data-testid="lyrics-status">
          Aligning lyrics…
        </span>
      )}
      {beats.analysis && (
        <span className={styles.toolStatus} data-testid="beats-readout">
          {formatBeatSummary(beats.analysis)}
        </span>
      )}
      <UpdateButton className={styles.toolButton} />
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
      <SessionHostButton className={styles.toolButton} />
      <QueueButtons className={styles.toolButton} />
    </header>
  );
});

/** A dropdown-trigger label: text + a trailing caret, so the header menus read
 *  as openable menus. */
const MenuLabel = ({ text }: { text: string }): React.ReactElement => (
  <>
    {text}
    <ChevronDown size={13} aria-hidden="true" className={styles.menuCaret} />
  </>
);

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
    // remount (back from karaoke view) starts at scrollLeft 0; the windowing still holds the old scrollX
    el.scrollLeft = viewport.scrollXPx;
    return () => ro.disconnect();
  }, [presenter, viewport]);

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

      // Line mode centres the current lyric line and zooms so all of its words
      // fit the bars area. Driven off the first lyrics track; positions
      // regardless of play state so the single visible line (see WindowedLines)
      // is always framed. Sets the zoom itself (via the presenter), so it reads
      // the line's own duration + viewport width rather than the live `ppb`.
      if (mode === 'line') {
        const track = lyricsStore.firstTrack;
        if (!track || track.lines.length === 0) return;
        const lineVw = viewport._viewportWidth;
        if (lineVw <= 0) return;
        const audioTime = playbackEngine.currentTime - playbackEngine.songLeadInSec;
        const idx = activeLineIndexAt(track.lines, audioTime, track.offsetSec) ?? 0;
        const span = lineSpanSec(track.lines, idx);
        // A word from the aligner can carry a non-finite time; a NaN span would
        // yield a NaN zoom. Skip this tick (keep the current frame) rather than
        // collapse the score.
        if (!Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)) return;
        const barsWidth = Math.max(1, lineVw - GUTTER_PX);
        // Cap the span so a line followed by a long instrumental gap (or the
        // final line before a far-off end tag) doesn't fit a huge span and zoom
        // the whole track out to nothing.
        const spanSec = Math.min(Math.max(0.001, span.endSec - span.startSec), LINE_MAX_SPAN_SEC);
        const endSec = span.startSec + spanSec;
        // Pad each side so the first/last word isn't flush to the bars-area edge;
        // the padded span is what fills the bars width.
        const paddedSec = spanSec * (1 + 2 * LINE_SPAN_PAD_FRAC);
        const zoom = Math.max(
          MIN_PX_PER_SECOND,
          Math.min(MAX_PX_PER_SECOND, barsWidth / paddedSec),
        );
        presenter.setZoom(zoom);
        // Centre the line's midpoint in the bars area (the region right of the
        // sticky gutter), not the whole viewport.
        const centerSec = (span.startSec + endSec) / 2 + track.offsetSec;
        el.scrollLeft = Math.max(0, centerSec * zoom - barsWidth / 2);
        return;
      }

      if (playbackEngine.state !== 'playing') return;
      const vw = viewport._viewportWidth;
      if (vw <= 0) return;
      const playheadX = playbackEngine.currentTime * ppb;
      el.scrollLeft = autoscrollTargetLeft(mode, playheadX, vw);
    });
  }, [viewport, presenter]);

  const onSeek = (x: number): void => presenter.seekToX(x);

  // Middle-button drag pans the score in both axes (a "grab" pan over the
  // native scroll container), suppressing the browser's middle-click autoscroll.
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 1) return;
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    el.style.cursor = 'grabbing';
    const onMove = (ev: MouseEvent): void => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const onUp = (): void => {
      el.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className={styles.scoreArea}
      ref={scrollRef}
      onScroll={(e) => presenter.setScrollX(e.currentTarget.scrollLeft)}
      onMouseDown={onMouseDown}
      data-testid="score-area"
    >
      {!hasContent && (
        <div className={styles.emptyState} data-testid="empty-state">
          Load a song from the File menu, or search for one in the Queue.
        </div>
      )}
      {!viewport.audioTracksHidden &&
        audioTrackIds.map((id) => {
          const track = playbackEngine.audioTracks.get(id);
          return track ? <AudioTrackView key={id} track={track} onSeek={onSeek} /> : null;
        })}
      {lyricsIds.map((id) => (
        <LyricsTrackView key={id} id={id} onSeek={onSeek} />
      ))}
    </div>
  );
});

/** Padding added to each side of a followed line's word span (as a fraction of
 *  the span's duration) before it's fit to the bars area, so the first/last word
 *  aren't flush against the edges. Small: the words should fill most of the row. */
const LINE_SPAN_PAD_FRAC = 0.06;

/** Cap (seconds) on a followed line's span used for the fit-zoom, so a line
 *  before a long instrumental gap doesn't zoom the whole track out to nothing. */
const LINE_MAX_SPAN_SEC = 12;

const SeekBar = observer(function SeekBar() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const song = React.useContext(SongStoreContext)!;
  return (
    <Slider
      thin
      className={styles.seekBar}
      value={playbackEngine.currentTime}
      max={song.durationSec}
      step="any"
      disabled={song.durationSec <= 0}
      onChange={(sec) => presenter.seek(sec)}
      ariaLabel="Seek"
      testId="karaoke-seek-bar"
    />
  );
});

const TransportBar = observer(function TransportBar() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const song = React.useContext(SongStoreContext)!;
  const skipSegments = React.useContext(SkipSegmentsStoreContext)!;
  const fullscreen = React.useContext(FullscreenStoreContext)!;
  const playing = playbackEngine.state === 'playing';
  const canPlay = song.durationSec > 0;
  const musicSec = skipSegments.musicDurationSec;
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
        {musicSec < song.durationSec ? ` (${formatPlayheadTime(musicSec)})` : ''}
      </span>
      <ScoringControls />
      <div className={styles.mixControls}>
        {fullscreen.viewMode === 'karaoke' && <StemMixControls />}
        <HomeAudioControls />
      </div>
      <FullscreenButton />
    </footer>
  );
});

const FullscreenButton = observer(function FullscreenButton() {
  const fullscreen = React.useContext(FullscreenStoreContext)!;
  const presenter = React.useContext(FullscreenPresenterContext)!;
  const label = fullscreen.active ? 'Exit fullscreen' : 'Fullscreen';
  return (
    <button
      type="button"
      className={styles.transportButton}
      onClick={() => presenter.toggle()}
      aria-label={label}
      title={label}
      data-testid="fullscreen-toggle"
    >
      {fullscreen.active ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}
    </button>
  );
});

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  tracks: 'Tracks',
  karaoke: 'Karaoke',
};

const AUTOSCROLL_LABELS: Record<AutoscrollMode, string> = {
  off: "Don't follow",
  center: 'Center',
  page: 'Page',
  line: 'Line',
};

/** Header "View" menu: view mode, plus (in the tracks view) follow-playhead mode,
 *  audio-track visibility, horizontal zoom, and lyrics font size. */
const ViewMenu = observer(function ViewMenu() {
  const fullscreen = React.useContext(FullscreenStoreContext)!;
  return (
    <DropdownButton
      label={<MenuLabel text="View" />}
      className={styles.toolButton}
      title="View mode, follow mode, track visibility, zoom, and lyrics size"
      testId="view-menu"
    >
      {() => (
        <>
          <DropdownSection label="View mode">
            {(Object.keys(VIEW_MODE_LABELS) as ViewMode[]).map((mode) => (
              <ToggleMenuItem
                key={mode}
                label={VIEW_MODE_LABELS[mode]}
                active={fullscreen.viewMode === mode}
                onToggle={() => appSettingsPresenter.setViewMode(mode)}
                disabled={fullscreen.active}
                role="menuitemradio"
                testId={`view-mode-${mode}`}
              />
            ))}
          </DropdownSection>
          {fullscreen.viewMode === 'tracks' ? (
            <TracksViewSections />
          ) : (
            <DropdownSection label="Lyrics">
              <ToggleMenuItem
                label="Show lyric pitch"
                active={appSettingsStore.karaokeShowPitch}
                onToggle={() => appSettingsPresenter.setKaraokeShowPitch(!appSettingsStore.karaokeShowPitch)}
                testId="karaoke-show-pitch"
              />
              <ToggleMenuItem
                label="Show 2 lines"
                active={appSettingsStore.karaokeTwoLines}
                onToggle={() => appSettingsPresenter.setKaraokeTwoLines(!appSettingsStore.karaokeTwoLines)}
                testId="karaoke-two-lines"
              />
            </DropdownSection>
          )}
          <DropdownSection label="Japanese">
            <ToggleMenuItem
              label="Show kanji"
              active={appSettingsStore.showKanji}
              onToggle={() => appSettingsPresenter.setShowKanji(!appSettingsStore.showKanji)}
              testId="show-kanji"
            />
            <ToggleMenuItem
              label="Show furigana"
              active={appSettingsStore.showFurigana}
              onToggle={() => appSettingsPresenter.setShowFurigana(!appSettingsStore.showFurigana)}
              testId="show-furigana"
            />
            <ToggleMenuItem
              label="Show romaji"
              active={appSettingsStore.showRomaji}
              onToggle={() => appSettingsPresenter.setShowRomaji(!appSettingsStore.showRomaji)}
              testId="show-romaji"
            />
          </DropdownSection>
          <DropdownSection label="Appearance">
            <ToggleMenuItem
              label="Light theme"
              active={appSettingsStore.theme === 'light'}
              onToggle={() => appSettingsPresenter.toggleTheme()}
              testId="light-theme"
            />
          </DropdownSection>
        </>
      )}
    </DropdownButton>
  );
});

const AudioMenu = observer(function AudioMenu() {
  return (
    <DropdownButton
      label={<MenuLabel text="Audio" />}
      className={styles.toolButton}
      title="Audio effects"
      testId="audio-menu"
    >
      {() => (
        <>
          <SubmenuItem label="Vocal track effects">{() => <VocalEffectItems />}</SubmenuItem>
          <DropdownSection label="Audio timing (ms)">
            <AudioTimingControl />
          </DropdownSection>
          <DropdownSection label="Speed">
            <SpeedControl />
          </DropdownSection>
        </>
      )}
    </DropdownButton>
  );
});

const SPEED_STEP = 0.05;

const SpeedControl = observer(function SpeedControl() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  return (
    <div className={styles.menuControlRow}>
      <NumberStepper
        value={playbackEngine.speed}
        onChange={(v) => presenter.setSpeed(v)}
        step={SPEED_STEP}
        min={MIN_SPEED}
        max={MAX_SPEED}
        precision={2}
        ariaLabel="Playback speed"
        title="Changes the tempo and keeps the pitch"
        testId="audio-speed"
      />
    </div>
  );
});

const AUDIO_OFFSET_STEP_MS = 50;

const AudioTimingControl = observer(function AudioTimingControl() {
  const store = React.useContext(AudioDeviceStoreContext)!;
  const presenter = React.useContext(AudioDevicePresenterContext)!;
  return (
    <div className={styles.menuControlRow}>
      <NumberStepper
        value={store.audioOffsetMs}
        onChange={(v) => presenter.setAudioOffsetMs(v)}
        step={AUDIO_OFFSET_STEP_MS}
        min={-MAX_AUDIO_OFFSET_MS}
        max={MAX_AUDIO_OFFSET_MS}
        precision={0}
        ariaLabel="Audio timing in milliseconds"
        title="Positive plays the audio later than the lyrics and video, negative earlier"
        testId="audio-offset"
      />
    </div>
  );
});

const VocalEffectItems = observer(function VocalEffectItems() {
  return (
    <ToggleMenuItem
      label="Surround reverb"
      active={appSettingsStore.vocalSurroundReverb}
      onToggle={() => appSettingsPresenter.setVocalSurroundReverb(!appSettingsStore.vocalSurroundReverb)}
      title="Widen and reverberate the vocal stem so it sits back like a backing vocal"
      testId="vocal-surround-reverb"
    />
  );
});

const TracksViewSections = observer(function TracksViewSections() {
  const presenter = React.useContext(KaraokePresenterContext)!;
  const viewport = React.useContext(ViewportStoreContext)!;
  return (
    <>
      <DropdownSection label="Follow playhead">
        {(Object.keys(AUTOSCROLL_LABELS) as AutoscrollMode[]).map((mode) => (
          <ToggleMenuItem
            key={mode}
            label={AUTOSCROLL_LABELS[mode]}
            active={appSettingsStore.autoscrollMode === mode}
            onToggle={() => appSettingsPresenter.setAutoscrollMode(mode)}
            role="menuitemradio"
            testId={`autoscroll-mode-${mode}`}
          />
        ))}
      </DropdownSection>
      <DropdownSection label="Tracks">
        <ToggleMenuItem
          label="Audio tracks"
          active={!viewport.audioTracksHidden}
          onToggle={() => presenter.toggleAudioTracks()}
          testId="toggle-audio-tracks"
        />
      </DropdownSection>
      <DropdownSection label="Zoom">
        <div className={styles.menuControlRow}>
          <Slider
            min={MIN_PX_PER_SECOND}
            max={MAX_PX_PER_SECOND}
            step={1}
            value={viewport.pxPerBeat}
            onChange={(v) => presenter.setZoom(v)}
            ariaLabel="Horizontal zoom (pixels per second)"
            className={styles.menuSlider}
          />
        </div>
      </DropdownSection>
      <DropdownSection label="Lyrics size">
        <div className={styles.menuControlRow}>
          <NumberStepper
            value={appSettingsStore.lyricsFontSizePx}
            onChange={(v) => appSettingsPresenter.setLyricsFontSize(v)}
            step={2}
            min={MIN_LYRIC_FONT_SIZE_PX}
            max={MAX_LYRIC_FONT_SIZE_PX}
            precision={0}
            ariaLabel="Lyrics font size"
            testId="lyrics-font-size"
          />
        </div>
      </DropdownSection>
    </>
  );
});

const Modals = observer(function Modals() {
  const lyricsPresenter = React.useContext(LyricsPresenterContext)!;
  const lyricsAlign = React.useContext(LyricsAlignStoreContext)!;
  const song = React.useContext(SongStoreContext)!;
  return (
    <>
      <LyricsSearchModal
        open={lyricsAlign.lyricsSearchOpen}
        initialTitle={song.title}
        initialArtist={song.artist}
        onClose={() => lyricsPresenter.setLyricsSearchOpen(false)}
        presenter={lyricsPresenter}
      />
      <LyricsTextLoadModal
        open={lyricsAlign.lyricsTextOpen}
        onClose={() => lyricsPresenter.setLyricsTextOpen(false)}
        presenter={lyricsPresenter}
      />
      <SettingsModal />
      <SongDetailsModal />
      <SessionJoinModal />
    </>
  );
});

