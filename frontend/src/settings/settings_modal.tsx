import { observer } from 'mobx-react-lite';
import React from 'react';
import { AudioSettings } from 'src/audio_devices/audio_settings';
import { AudioDevicePresenterContext } from 'src/audio_devices/audio_device_contexts';
import { MusicSourcesSettings } from 'src/music_source/music_sources_settings';
import { MusicSourcePresenterContext } from 'src/music_source/music_source_contexts';
import { Modal, ModalHeader } from 'src/ui/modal/modal';
import { Tabs } from 'src/ui/tabs/tabs';
import { useSettingsModal, type SettingsTab } from './settings_modal_context';

const TAB_OPTIONS: ReadonlyArray<{ value: SettingsTab; label: string; testId: string }> = [
  { value: 'sources', label: 'Music sources', testId: 'settings-tab-sources' },
  { value: 'audio', label: 'Audio', testId: 'settings-tab-audio' },
];

/**
 * The app's Settings dialog: a tabbed <Modal> hosting the music-source
 * ("Music sources") and audio-device ("Audio") panels. Open/tab state comes
 * from the global {@link useSettingsModal} context; each panel reads its own
 * domain via context. Opening it lazily loads the service catalog + enumerates
 * audio devices.
 */
export const SettingsModal = observer(function SettingsModal() {
  const { open, tab, close, setTab } = useSettingsModal();
  const musicPresenter = React.useContext(MusicSourcePresenterContext);
  const audioPresenter = React.useContext(AudioDevicePresenterContext);

  React.useEffect(() => {
    if (!open) return;
    void musicPresenter?.ensureLoaded();
    void audioPresenter?.refreshDevices();
  }, [open, musicPresenter, audioPresenter]);

  if (!open) return null;

  return (
    <Modal
      open
      onClose={close}
      ariaLabel="Settings"
      width={620}
      maxHeight
      testId="settings-modal"
    >
      <ModalHeader title="Settings" onClose={close} closeLabel="Close settings" />
      <Tabs options={TAB_OPTIONS} value={tab} onChange={setTab} ariaLabel="Settings sections" />
      {tab === 'sources' ? <MusicSourcesSettings /> : <AudioSettings />}
    </Modal>
  );
});
