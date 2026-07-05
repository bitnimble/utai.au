import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import type { ServiceInfo } from 'src/net/music_source_client';
import { Checkbox } from 'src/ui/checkbox/checkbox';
import { Modal, ModalHeader } from 'src/ui/modal/modal';
import { Select } from 'src/ui/select/select';
import { MusicSourcePresenterContext, MusicSourceStoreContext } from './music_source_contexts';
import type { MusicSourcePresenter } from './music_source_presenter';
import type { MusicSourceStore } from './music_source_store';
import styles from './music_settings_modal.module.css';

const AUDIO_FORMATS = ['mp3', 'm4a', 'flac', 'ogg'] as const;
const BITRATES = ['128k', '256k', '320k', 'lossless'] as const;

/**
 * Music-source settings: sign in to each streaming service (the affordance
 * depends on how the service authenticates), rank services by priority (which
 * one's results appear first), enable/disable them, and pick download quality.
 * Credentials are sent to the local OnTheSpot backend, never persisted here.
 */
export const MusicSettingsModal = observer(function MusicSettingsModal() {
  const store = React.useContext(MusicSourceStoreContext);
  const presenter = React.useContext(MusicSourcePresenterContext);
  if (store == null || presenter == null || !store.settingsOpen) return null;

  const services = store.orderedServices;

  return (
    <Modal
      open
      onClose={() => presenter.closeSettings()}
      ariaLabel="Music source settings"
      width={620}
      maxHeight
      testId="music-settings-modal"
    >
      <ModalHeader
        title="Music sources"
        onClose={() => presenter.closeSettings()}
        closeLabel="Close music settings"
      />
      <div className={styles.body}>
        <p className={styles.intro}>
          Sign in to your streaming services, then rank which service&rsquo;s results appear
          first. Credentials stay on this machine.
        </p>
        {services.length === 0 ? (
          <div className={styles.loading} data-testid="music-settings-loading">
            Loading services…
          </div>
        ) : (
          <ul className={styles.serviceList}>
            {services.map((service, i) => (
              <ServiceRow
                key={service.id}
                service={service}
                isFirst={i === 0}
                isLast={i === services.length - 1}
                store={store}
                presenter={presenter}
              />
            ))}
          </ul>
        )}
        <QualitySection store={store} presenter={presenter} />
      </div>
    </Modal>
  );
});

const ServiceRow = observer(function ServiceRow({
  service,
  isFirst,
  isLast,
  store,
  presenter,
}: {
  service: ServiceInfo;
  isFirst: boolean;
  isLast: boolean;
  store: MusicSourceStore;
  presenter: MusicSourcePresenter;
}) {
  return (
    <li className={styles.serviceRow} data-testid={`music-service-${service.id}`}>
      <div className={styles.rowMain}>
        <div className={styles.priorityArrows}>
          <button
            type="button"
            className={styles.arrowButton}
            onClick={() => void presenter.nudgePriority(service.id, 'up')}
            disabled={isFirst}
            aria-label={`Raise ${service.label} priority`}
          >
            <ChevronUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.arrowButton}
            onClick={() => void presenter.nudgePriority(service.id, 'down')}
            disabled={isLast}
            aria-label={`Lower ${service.label} priority`}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.serviceName}>
          <span className={styles.serviceLabel}>{service.label}</span>
          <span className={service.configured ? styles.statusOn : styles.statusOff}>
            {service.configured ? 'Signed in' : 'Not signed in'}
          </span>
        </div>
        <label className={styles.enableLabel} title={service.configured ? '' : 'Sign in first'}>
          <Checkbox
            checked={store.isEnabled(service.id) && service.configured}
            disabled={!service.configured}
            onChange={(e) => void presenter.setEnabled(service.id, e.target.checked)}
            data-testid={`music-enable-${service.id}`}
          />
          Search
        </label>
      </div>
      <AccountControls service={service} presenter={presenter} />
    </li>
  );
});

const AccountControls = observer(function AccountControls({
  service,
  presenter,
}: {
  service: ServiceInfo;
  presenter: MusicSourcePresenter;
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [token, setToken] = React.useState('');

  if (service.configured) {
    return (
      <div className={styles.accountControls}>
        <button
          type="button"
          className={styles.removeButton}
          disabled={service.accountUuid == null}
          onClick={() => service.accountUuid != null && void presenter.removeAccount(service.accountUuid)}
          data-testid={`music-remove-${service.id}`}
        >
          <Trash2 size={13} aria-hidden="true" /> Remove
        </button>
      </div>
    );
  }

  if (service.authKind === 'anonymous') {
    return (
      <div className={styles.accountControls}>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => void presenter.addAccount({ service: service.id })}
          data-testid={`music-add-${service.id}`}
        >
          Enable
        </button>
      </div>
    );
  }

  if (service.authKind === 'interactive') {
    return (
      <div className={styles.accountControls}>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => void presenter.addAccount({ service: service.id })}
          data-testid={`music-add-${service.id}`}
        >
          Sign in via OnTheSpot
        </button>
      </div>
    );
  }

  if (service.authKind === 'token') {
    return (
      <form
        className={styles.accountControls}
        onSubmit={(e) => {
          e.preventDefault();
          void presenter.addAccount({ service: service.id, token });
        }}
      >
        <input
          type="password"
          className={styles.credField}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={service.tokenLabel ?? 'Token'}
          aria-label={`${service.label} ${service.tokenLabel ?? 'token'}`}
          data-testid={`music-token-${service.id}`}
        />
        <button type="submit" className={styles.addButton} disabled={token.length === 0}>
          Add
        </button>
      </form>
    );
  }

  // credentials (email + password)
  return (
    <form
      className={styles.accountControls}
      onSubmit={(e) => {
        e.preventDefault();
        void presenter.addAccount({ service: service.id, email, password });
      }}
    >
      <input
        type="email"
        className={styles.credField}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        aria-label={`${service.label} email`}
        data-testid={`music-email-${service.id}`}
      />
      <input
        type="password"
        className={styles.credField}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        aria-label={`${service.label} password`}
        data-testid={`music-password-${service.id}`}
      />
      <button
        type="submit"
        className={styles.addButton}
        disabled={email.length === 0 || password.length === 0}
      >
        Add
      </button>
    </form>
  );
});

const QualitySection = observer(function QualitySection({
  store,
  presenter,
}: {
  store: MusicSourceStore;
  presenter: MusicSourcePresenter;
}) {
  const quality = store.config?.quality;
  if (quality == null) return null;
  return (
    <div className={styles.quality} data-testid="music-quality">
      <span className={styles.qualityTitle}>Download quality</span>
      <label className={styles.qualityField}>
        Format
        <Select
          value={quality.format}
          onChange={(e) => void presenter.setQuality({ format: e.target.value })}
          data-testid="music-quality-format"
        >
          {AUDIO_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f.toUpperCase()}
            </option>
          ))}
        </Select>
      </label>
      <label className={styles.qualityField}>
        Bitrate
        <Select
          value={quality.bitrate}
          onChange={(e) => void presenter.setQuality({ bitrate: e.target.value })}
          data-testid="music-quality-bitrate"
        >
          {BITRATES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
});
