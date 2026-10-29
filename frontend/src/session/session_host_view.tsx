import classNames from 'classnames';
import { QrCode } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { Modal, ModalBody, ModalHeader } from 'src/ui/modal/modal';
import { JoinDetails, joinStyles } from './join_details';
import { SessionHostPresenterContext, SessionHostStoreContext } from './session_host_contexts';
import styles from './session_host_view.module.css';

export const SessionHostButton = observer(function SessionHostButton({ className }: { className: string }) {
  const store = React.useContext(SessionHostStoreContext);
  const presenter = React.useContext(SessionHostPresenterContext);
  if (store == null || presenter == null) return null;
  const { status } = store;
  if (store.ended) {
    return (
      <button
        type="button"
        className={classNames(className, styles.warning)}
        onClick={() => void presenter.startNewSession()}
        title="Phones can't join this session any more. Start a new one."
        data-testid="session-ended"
      >
        Session ended
      </button>
    );
  }
  if (status === 'replaced') {
    return (
      <button
        type="button"
        className={classNames(className, styles.warning)}
        onClick={() => presenter.reclaim()}
        title="Another device took over this session. Host it here again."
        data-testid="session-reclaim"
      >
        Hosted elsewhere
      </button>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => presenter.openJoin()}
      title="Show how phones join as a remote"
      data-testid="session-join-open"
    >
      <QrCode size={14} aria-hidden="true" />
      <span className={classNames(styles.code, status !== 'open' && styles.offline)} data-testid="session-code">
        {store.code}
      </span>
    </button>
  );
});

export const SessionJoinModal = observer(function SessionJoinModal() {
  const store = React.useContext(SessionHostStoreContext);
  const presenter = React.useContext(SessionHostPresenterContext);
  if (store == null || presenter == null) return null;
  const joinUrl = store.joinUrl;
  const close = (): void => presenter.closeJoin();
  return (
    <Modal open={store.joinOpen} onClose={close} ariaLabel="Join as a remote" width={380} testId="session-join-modal">
      <ModalHeader title="Join as a remote" onClose={close} />
      <ModalBody className={joinStyles.body}>
        {joinUrl == null && <p className={joinStyles.hint}>Set the address phones should open below.</p>}
        <JoinDetails joinUrl={joinUrl} code={store.code} />
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Address phones open</span>
          <input
            type="url"
            className={styles.input}
            value={appSettingsStore.remoteBaseUrl}
            placeholder={store.session.info.publicUrl ?? 'https://karaoke.lan'}
            onChange={(e) => appSettingsPresenter.setRemoteBaseUrl(e.target.value)}
            data-testid="session-remote-url"
          />
        </label>
      </ModalBody>
    </Modal>
  );
});
