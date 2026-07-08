import { observer } from 'mobx-react-lite';
import React from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader, modalStyles } from 'src/ui/modal/modal';
import { KaraokePresenterContext, SongIoPresenterContext, SongStoreContext } from './karaoke_contexts';
import { SongMeta } from './song_schema';
import styles from './song_details_modal.module.css';

/** The song facts carried in a saved bundle's `index.json`. Auto-filled
 *  from a streaming fetch / LRCLIB pick; editable here before saving. */
const FIELDS: { key: keyof SongMeta; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Song title' },
  { key: 'artist', label: 'Artist', placeholder: 'Artist' },
  { key: 'album', label: 'Album', placeholder: 'Album' },
  { key: 'albumArtUrl', label: 'Album art URL', placeholder: 'https://…' },
  { key: 'musicVideoUrl', label: 'Music video URL', placeholder: 'https://youtube.com/…' },
  { key: 'sourceUrl', label: 'Source URL', placeholder: 'https://…' },
];

export const SongDetailsModal = observer(function SongDetailsModal() {
  const songIo = React.useContext(SongIoPresenterContext)!;
  const song = React.useContext(SongStoreContext)!;
  const presenter = React.useContext(KaraokePresenterContext)!;
  const open = songIo.detailsOpen;
  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={() => songIo.closeDetails()}
      ariaLabel="Song details"
      width={520}
      testId="song-details-modal"
    >
      <ModalHeader
        title="Song details"
        onClose={() => songIo.closeDetails()}
        closeLabel="Close song details"
        closeTestId="song-details-close"
      />
      <ModalBody>
        <div className={styles.form}>
          {FIELDS.map(({ key, label, placeholder }) => (
            <label key={key} className={styles.row}>
              <span className={styles.label}>{label}</span>
              <input
                type="text"
                className={styles.input}
                value={song[key]}
                placeholder={placeholder}
                onChange={(e) => presenter.updateSongMeta({ [key]: e.target.value })}
                data-testid={`song-details-${key}`}
              />
            </label>
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <span className={modalStyles.footerSpacer} />
        <button
          type="button"
          className={modalStyles.primaryButton}
          onClick={() => songIo.closeDetails()}
          data-testid="song-details-done"
        >
          Done
        </button>
      </ModalFooter>
    </Modal>
  );
});
