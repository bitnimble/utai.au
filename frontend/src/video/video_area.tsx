import { observer } from 'mobx-react-lite';
import React from 'react';
import { VideoPresenterContext, VideoStoreContext } from './video_contexts';
import { VideoPresenter } from './video_presenter';
import styles from './video_area.module.css';

/**
 * The gap between the toolbar and the (bottom-anchored) score: hosts the muted
 * YouTube backing video when the loaded song came from YouTube, and is empty
 * space otherwise. Always rendered so the score stays pinned to the bottom.
 */
export const VideoArea = observer(function VideoArea() {
  const store = React.useContext(VideoStoreContext)!;
  const presenter = React.useContext(VideoPresenterContext)!;
  return (
    <div className={styles.videoArea} data-testid="video-area">
      {store.videoId != null && <VideoPlayer presenter={presenter} />}
    </div>
  );
});

const VideoPlayer = ({ presenter }: { presenter: VideoPresenter }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    presenter.attach(host);
    return () => presenter.detach();
  }, [presenter]);
  return (
    <div className={styles.videoFrame}>
      <div ref={hostRef} className={styles.videoHost} data-testid="video-host" />
    </div>
  );
};
