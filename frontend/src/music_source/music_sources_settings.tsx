import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import type { ServiceInfo } from 'src/net/music_source_client';
import { Checkbox } from 'src/ui/checkbox/checkbox';
import { MusicSourcePresenterContext, MusicSourceStoreContext } from './music_source_contexts';
import type { MusicSourcePresenter } from './music_source_presenter';
import styles from './music_sources_settings.module.css';

/**
 * Music-source settings (the "Music sources" tab): sign in to each streaming
 * service (the affordance depends on how the service authenticates) and rank
 * services by priority (which one's results appear first). Every connected
 * service is searched; there's no per-service search toggle. Credentials are
 * sent to the local OnTheSpot backend, never persisted here.
 */
export const MusicSourcesSettings = observer(function MusicSourcesSettings() {
  const store = React.useContext(MusicSourceStoreContext);
  const presenter = React.useContext(MusicSourcePresenterContext);
  if (store == null || presenter == null) return null;

  const services = store.orderedServices;

  return (
    <div className={styles.body}>
      <p className={styles.intro}>
        Sign in to your streaming services, then rank which service&rsquo;s results appear first.
        Credentials stay on this machine.
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
              presenter={presenter}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

const ServiceRow = observer(function ServiceRow({
  service,
  isFirst,
  isLast,
  presenter,
}: {
  service: ServiceInfo;
  isFirst: boolean;
  isLast: boolean;
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
            {service.authKind === 'anonymous'
              ? 'No sign-in needed'
              : service.configured
                ? 'Signed in'
                : 'Not signed in'}
          </span>
        </div>
      </div>
      <AccountControls service={service} presenter={presenter} />
      {service.id === 'youtube_music' && <YoutubeSearchOption presenter={presenter} />}
    </li>
  );
});

const YoutubeSearchOption = observer(function YoutubeSearchOption({
  presenter,
}: {
  presenter: MusicSourcePresenter;
}) {
  const store = React.useContext(MusicSourceStoreContext);
  return (
    <label className={styles.option}>
      <Checkbox
        checked={store?.config?.includeYoutubeSearch ?? false}
        onChange={(e) => void presenter.setIncludeYoutubeSearch(e.target.checked)}
        data-testid="music-include-youtube-search"
      />
      Also show regular YouTube results (any upload, not just music)
    </label>
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

  // Anonymous services (YouTube Music) need no sign-in and nothing to remove, so
  // there are no account controls; search seeds their account automatically.
  if (service.authKind === 'anonymous') return null;

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

  if (service.authKind === 'oauth') {
    return <SpotifyOAuthControls presenter={presenter} />;
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

/**
 * Spotify's OAuth paste flow. Spotify only allows librespot's loopback redirect
 * (`127.0.0.1:5588`), which can't reach this server remotely, so after
 * approving, the user copies the code (or the dead redirect URL) off that page
 * and pastes it back here.
 */
const SpotifyOAuthControls = observer(function SpotifyOAuthControls({
  presenter,
}: {
  presenter: MusicSourcePresenter;
}) {
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const begin = async (): Promise<void> => {
    setBusy(true);
    const started = await presenter.spotifyOAuthStart();
    setBusy(false);
    if (started == null) return;
    setSessionId(started.sessionId);
    window.open(started.authUrl, '_blank', 'noopener');
  };

  const finish = async (): Promise<void> => {
    if (sessionId == null) return;
    setBusy(true);
    const ok = await presenter.spotifyOAuthComplete(sessionId, code);
    setBusy(false);
    if (ok) {
      setSessionId(null);
      setCode('');
    }
  };

  if (sessionId == null) {
    return (
      <div className={styles.accountControls}>
        <button
          type="button"
          className={styles.addButton}
          disabled={busy}
          onClick={() => void begin()}
          data-testid="music-add-spotify"
        >
          Sign in with Spotify
        </button>
      </div>
    );
  }

  return (
    <div className={styles.oauthFlow}>
      <p className={styles.oauthHint}>
        Approve in the Spotify tab. Your browser then lands on a{' '}
        <code>127.0.0.1:5588</code> page that won&rsquo;t load, copy that page&rsquo;s URL (or the{' '}
        <code>code</code> from it) and paste it here.
      </p>
      <form
        className={styles.oauthForm}
        onSubmit={(e) => {
          e.preventDefault();
          void finish();
        }}
      >
        <input
          type="text"
          className={styles.credField}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Paste code or redirect URL"
          aria-label="Spotify authorization code"
          data-testid="music-spotify-code"
        />
        <button type="submit" className={styles.addButton} disabled={busy || code.length === 0}>
          {busy ? 'Finishing…' : 'Finish'}
        </button>
      </form>
    </div>
  );
});
