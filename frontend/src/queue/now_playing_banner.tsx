import { observer } from 'mobx-react-lite';
import React from 'react';
import { QueueStoreContext } from './queue_contexts';
import styles from './now_playing_banner.module.css';

/** Announces each song as it starts, title-card style, across the video area. */
export const NowPlayingBanner = observer(function NowPlayingBanner() {
  const song = React.useContext(QueueStoreContext)!.nowPlaying;
  if (song == null) return null;
  return (
    <div key={song.id} className={styles.banner} data-testid="now-playing-banner">
      <div className={styles.title}>{song.title}</div>
      {song.artist && <div className={styles.artist}>{song.artist}</div>}
    </div>
  );
});
