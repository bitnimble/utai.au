import { CircleArrowDown } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { useSettingsModal } from 'src/settings/settings_modal_context';
import { UpdatesStoreContext } from './updates_contexts';

/** A toolbar button, present only while a newer release exists, opening the Updates tab. */
export const UpdateButton = observer(function UpdateButton({ className }: { className?: string }) {
  const store = React.useContext(UpdatesStoreContext);
  const settingsModal = useSettingsModal();
  const latest = store?.latest;
  if (latest == null) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={() => settingsModal.openSettings('updates')}
      title={`Version ${latest.version} is available`}
      data-testid="update-available"
    >
      <CircleArrowDown size={14} aria-hidden="true" /> Update
    </button>
  );
});
