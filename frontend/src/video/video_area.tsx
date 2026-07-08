import { observer } from 'mobx-react-lite';
import React from 'react';
import { VideoPresenterContext, VideoStoreContext } from './video_contexts';
import { VideoPresenter } from './video_presenter';
import styles from './video_area.module.css';

/**
 * The gap between the toolbar and the (bottom-anchored) score: hosts the muted
 * backing video when the loaded song came from YouTube, and is empty space
 * otherwise. Always rendered so the score stays pinned to the bottom. The
 * primary backing is a native `<video>` over a yt-dlp-fetched stream; it swaps
 * to the YouTube IFrame embed once that video's native fetch has failed
 * (`store.useEmbed`).
 */
export const VideoArea = observer(function VideoArea() {
  const store = React.useContext(VideoStoreContext)!;
  const presenter = React.useContext(VideoPresenterContext)!;
  if (store.videoId == null) {
    return <div className={styles.videoArea} data-testid="video-area" />;
  }
  return (
    <div className={styles.videoArea} data-testid="video-area">
      <div className={styles.videoFrame}>
        {store.useEmbed ? (
          <EmbedPlayer presenter={presenter} />
        ) : (
          <NativePlayer presenter={presenter} />
        )}
      </div>
    </div>
  );
});

const NativePlayer = ({ presenter }: { presenter: VideoPresenter }) => {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    presenter.attachNative(el);
    return () => presenter.detach();
  }, [presenter]);
  return <video ref={ref} className={styles.videoHost} data-testid="video-native" muted playsInline />;
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
