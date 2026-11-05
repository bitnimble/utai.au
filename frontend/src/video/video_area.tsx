import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { VideoPresenterContext, VideoStoreContext } from './video_contexts';
import { VideoPresenter } from './video_presenter';
import styles from './video_area.module.css';

/**
 * The space between the toolbar and the score (or the footer, in the karaoke
 * view): hosts the muted backing video when the loaded song came from YouTube,
 * and is empty space otherwise. Always rendered so the score stays pinned to
 * the bottom. The
 * primary backing is a native `<video>` over a yt-dlp-fetched stream; it swaps
 * to the YouTube IFrame embed once that video's native fetch has failed
 * (`store.useEmbed`). `children` render laid over the area.
 */
export const VideoArea = observer(function VideoArea({ children }: { children?: React.ReactNode }) {
  const store = React.useContext(VideoStoreContext)!;
  const presenter = React.useContext(VideoPresenterContext)!;
  return (
    <div className={styles.videoArea} data-testid="video-area">
      {store.videoId != null && (
        <div className={styles.videoFrame}>
          {store.useEmbed ? (
            <EmbedPlayer presenter={presenter} />
          ) : (
            <NativePlayer presenter={presenter} />
          )}
        </div>
      )}
      {children}
    </div>
  );
});

const NativePlayer = observer(function NativePlayer({ presenter }: { presenter: VideoPresenter }) {
  const store = React.useContext(VideoStoreContext)!;
  const first = React.useRef<HTMLVideoElement>(null);
  const second = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    if (!first.current || !second.current) return;
    presenter.attachNative([first.current, second.current]);
    return () => presenter.detach();
  }, [presenter]);
  return (
    <>
      {[first, second].map((ref, slot) => (
        <video
          key={slot}
          ref={ref}
          className={classNames(styles.videoHost, slot !== store.activeSlot && styles.videoStandby)}
          data-testid={slot === store.activeSlot ? 'video-native' : 'video-standby'}
          // WebGL can only read a cross-origin video's frames under CORS.
          crossOrigin="anonymous"
          muted
          playsInline
        />
      ))}
      {appSettingsStore.videoEffect !== 'none' && <EffectCanvas presenter={presenter} first={first} second={second} />}
    </>
  );
});

const EffectCanvas = ({
  presenter,
  first,
  second,
}: {
  presenter: VideoPresenter;
  first: React.RefObject<HTMLVideoElement | null>;
  second: React.RefObject<HTMLVideoElement | null>;
}) => {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    if (!canvas.current || !first.current || !second.current) return;
    presenter.attachEffect(canvas.current, [first.current, second.current]);
    return () => presenter.detachEffect();
  }, [presenter, first, second]);
  return <canvas ref={canvas} className={styles.effectCanvas} data-testid="video-effect-canvas" />;
};

const EmbedPlayer = ({ presenter }: { presenter: VideoPresenter }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    presenter.attachEmbed(host);
    return () => presenter.detach();
  }, [presenter]);
  return <div ref={hostRef} className={styles.videoHost} data-testid="video-host" />;
};
