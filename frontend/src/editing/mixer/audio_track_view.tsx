import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import React from 'react';
import type { StructuralPresenter } from 'src/editing/structure/structural_presenter';
import { AudioTrack } from 'src/editing/playback/audio_tracks';
import { waveformWorker, BarSlice } from 'src/editing/playback/waveform_worker_client';
import { WAVEFORM_PAINT_COLOR } from 'src/editing/utils/waveform_color';
import { BarBeat, WaveformChunk, buildChunkLayout } from './waveform_chunks';
import { StructuralContext } from '../jot_editor_contexts';
import { ViewportStoreContext } from '../viewport/viewport_contexts';
import styles from './audio_track_view.module.css';
import { Playhead } from '../playback/playhead';
import { seekFromClick } from '../score/seek';
import { barsRowWidthSeed } from '../utils/windowing';

/** Row height shared by the gutter label and the bars-row waveform. */
const AUDIO_TRACK_HEIGHT = 76;

/** Display name: filename with its extension stripped. */
function audioTrackLabel(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '') || filename;
}

/**
 * One audio-track row: a sticky gutter (filename) on the left and the
 * tiled waveform + playhead on the right, sharing the score's horizontal
 * time axis. Click-to-seek anywhere on the bars row.
 */
export const AudioTrackView = observer(
  ({ track, onSeek }: { track: AudioTrack; onSeek: (x: number) => void }) => {
    const structural = React.useContext(StructuralContext);
    const layerBeats = structural?.layerBeats ?? 0;
    const label = audioTrackLabel(track.filename);
    return (
      <div className={styles.musicTrack} data-testid={`audio-track-row-${track.id}`}>
        <div className={styles.musicTrackGutter} style={{ height: AUDIO_TRACK_HEIGHT }}>
          <span className={styles.musicTrackName} title={track.filename}>
            {label}
          </span>
        </div>
        <div
          className={styles.musicTrackBarsRow}
          data-bars-row
          style={
            {
              ['--layer-beats' as string]: layerBeats,
              ['--bars-row-width' as string]: structural
                ? barsRowWidthSeed(structural, layerBeats)
                : '0px',
              height: AUDIO_TRACK_HEIGHT,
            } as React.CSSProperties
          }
          onClick={(e) => seekFromClick(e, onSeek)}
        >
          <AudioTrackWaveformCanvas
            structural={structural}
            track={track}
            height={AUDIO_TRACK_HEIGHT}
            testId={`audio-track-waveform-${track.id}`}
          />
          <Playhead onSeek={onSeek} />
        </div>
      </div>
    );
  },
);

const CHUNK_VIEWPORT_MARGIN_PX = 1200;

const AudioTrackWaveformCanvas = observer(
  ({
    structural,
    track,
    height,
    testId,
  }: {
    structural: StructuralPresenter | null;
    track: AudioTrack;
    height: number;
    testId?: string;
  }) => {
    const viewport = React.useContext(ViewportStoreContext);
    const padBeats = structural?.config.barNotePaddingBeats ?? 0;
    // Whole-song span drives the chunk layout so every row's tiles align
    // on the shared time axis. Beat-stable (pure of pixels), so memo it.
    const durationSec = structural?.layerBeats ?? 0;
    const layout = React.useMemo(() => buildChunkLayout(durationSec), [durationSec]);
    const livePxPerBeat = structural?.pxPerBeat ?? 0;

    if (!viewport || layout.chunks.length === 0) return null;
    const scrollX = viewport.scrollX;
    const viewportWidth = viewport._viewportWidth;
    if (viewportWidth <= 0 || livePxPerBeat <= 0) return null;
    const visibleLeft = scrollX - CHUNK_VIEWPORT_MARGIN_PX;
    const visibleRight = scrollX + viewportWidth + CHUNK_VIEWPORT_MARGIN_PX;
    const padPx = padBeats * livePxPerBeat;

    const visibleChunks: WaveformChunk[] = [];
    for (const c of layout.chunks) {
      const left = c.startBeat * livePxPerBeat + padPx;
      const right = left + c.totalBeats * livePxPerBeat;
      if (right > visibleLeft && left < visibleRight) visibleChunks.push(c);
    }
    if (visibleChunks.length === 0) return null;

    const ampScale = waveformWorker.getAmpScale(track.id);

    return (
      <>
        {visibleChunks.map((chunk, i) => (
          <AudioTrackWaveformChunk
            key={chunk.key}
            track={track}
            chunk={chunk}
            bars={layout.bars}
            height={height}
            laneColor={track.color}
            ampScale={ampScale}
            livePxPerBeat={livePxPerBeat}
            padBeats={padBeats}
            testId={i === 0 ? testId : undefined}
          />
        ))}
      </>
    );
  },
);

/** One canvas tile in the tiled waveform row. Transfers its `<canvas>` to
 *  the track's worker on mount; the worker computes peaks + paints into it
 *  directly (no bytes cross back). */
const AudioTrackWaveformChunk = observer(
  ({
    track,
    chunk,
    bars,
    height,
    laneColor,
    ampScale,
    livePxPerBeat,
    padBeats,
    testId,
  }: {
    track: AudioTrack;
    chunk: WaveformChunk;
    bars: BarBeat[];
    height: number;
    laneColor: string | undefined;
    ampScale: number;
    livePxPerBeat: number;
    padBeats: number;
    testId?: string;
  }) => {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const songLeadInSec = 0;
    const chunkKey = `${track.id}:${chunk.key}`;

    // Snap left/width to integer CSS px so the canvas backing store and the
    // peak buffer are whole integers and adjacent tiles share an exactly
    // aligned boundary (no brightness step).
    const chunkLayout = React.useMemo(() => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const padPx = Math.round(padBeats * livePxPerBeat * dpr) / dpr;
      const leftRaw = chunk.startBeat * livePxPerBeat + padPx;
      const rightRaw = leftRaw + chunk.totalBeats * livePxPerBeat;
      const left = Math.round(leftRaw);
      const right = Math.round(rightRaw);
      return { left, width: Math.max(0, right - left) };
    }, [chunk.startBeat, chunk.totalBeats, livePxPerBeat, padBeats]);

    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (typeof canvas.transferControlToOffscreen !== 'function') {
        console.warn('[mixer] OffscreenCanvas not supported; waveform chunk will not render');
        return;
      }
      const offscreen = canvas.transferControlToOffscreen();
      waveformWorker.attachChunk(chunkKey, offscreen, track.id);
      return () => {
        waveformWorker.releaseChunk(chunkKey);
      };
    }, [chunkKey, track.id]);

    const isFirstDrawRef = React.useRef(true);
    React.useEffect(() => {
      if (chunk.totalBeats <= 0 || livePxPerBeat <= 0) return;
      const widthPx = chunkLayout.width;
      if (widthPx <= 0) return;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const MAX_CANVAS_DIM = 16384;
      const backingW = Math.min(Math.max(1, widthPx * dpr), MAX_CANVAS_DIM);
      const backingH = Math.min(Math.max(1, Math.floor(height * dpr)), MAX_CANVAS_DIM);
      const renderedScale = widthPx / chunk.totalBeats;
      const cStart = chunk.startBeat;
      const cEnd = chunk.startBeat + chunk.totalBeats;
      let firstIdx = 0;
      while (firstIdx < bars.length && bars[firstIdx].startBeat + bars[firstIdx].beats <= cStart) {
        firstIdx++;
      }
      let lastIdx = firstIdx;
      while (lastIdx < bars.length && bars[lastIdx].startBeat < cEnd) lastIdx++;
      const chunkBars = bars.slice(firstIdx, Math.min(bars.length, lastIdx + 1));
      const barSlices: BarSlice[] = chunkBars.map((b, idx) => ({
        x: (b.startBeat - chunk.startBeat) * renderedScale,
        width: b.beats * renderedScale,
        startSec: b.startSec,
        durationSec: b.durationSec,
        driftSec: b.driftSec,
        nextDriftSec: chunkBars[idx + 1]?.driftSec ?? b.driftSec,
      }));
      const fire = () => {
        waveformWorker.renderChunk(
          chunkKey,
          barSlices,
          widthPx,
          height,
          backingW,
          backingH,
          songLeadInSec,
          laneColor ?? WAVEFORM_PAINT_COLOR,
          ampScale,
        );
      };
      if (isFirstDrawRef.current) {
        isFirstDrawRef.current = false;
        fire();
        return;
      }
      const id = requestAnimationFrame(fire);
      return () => cancelAnimationFrame(id);
    }, [chunkKey, chunk, bars, height, livePxPerBeat, laneColor, ampScale, chunkLayout.width]);

    return (
      <canvas
        ref={canvasRef}
        className={classNames(styles.musicTrackWaveformChunk)}
        style={
          {
            height,
            left: `${chunkLayout.left}px`,
            width: `${chunkLayout.width}px`,
          } as React.CSSProperties
        }
        data-testid={testId}
      />
    );
  },
);
