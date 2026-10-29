import { invoke, isTauri } from '@tauri-apps/api/core';
import { when } from 'mobx';
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'src/design_tokens.css';
import { pageLog } from 'src/log_viewer/page_log';
import { hasLocalBackend } from 'src/net/local_backend';
import { ProvisioningPresenter } from 'src/provisioning/provisioning_presenter';
import { HttpProvisioningSource } from 'src/provisioning/provisioning_source';
import { ProvisioningStore } from 'src/provisioning/provisioning_store';
import { parseRoute } from 'src/session/app_route';
import { HostPage } from 'src/session/host_page';
import { HostPagePresenter, type HostTarget } from 'src/session/host_page_presenter';
import { HostPageStore } from 'src/session/host_page_store';
import { LandingPage } from 'src/session/landing_page';
import { RemotePage } from 'src/session/remote/remote_page';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { SettingsModalProvider } from 'src/settings/settings_modal_context';
import { ErrorBoundary } from 'src/ui/error_boundary/error_boundary';
import { ModalProvider } from 'src/ui/modal/modal_manager';
import { followRemote } from 'src/tv_remote/remote_navigation';
import { onTv } from 'src/tv_remote/tv';
import { toastStore } from 'src/ui/toasts/toasts';
import { UpdatesPresenterContext, UpdatesStoreContext } from 'src/updates/updates_contexts';
import { UpdatesPresenter } from 'src/updates/updates_presenter';
import { UpdatesStore } from 'src/updates/updates_store';

const LOCAL_BACKEND_RETRY_MS = 15_000;

pageLog.follow();
if (onTv()) followRemote();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount element');

createRoot(container).render(
  <ErrorBoundary>
    <React.StrictMode>
      <ModalProvider>{renderRoute()}</ModalProvider>
    </React.StrictMode>
  </ErrorBoundary>,
);

function renderRoute(): React.ReactElement {
  const route = parseRoute(window.location.pathname);
  // The remote is served from the same origin as the session API (the site, or the desktop app's gateway).
  if (route.kind === 'remote') return <RemotePage sessionId={route.sessionId} apiBase="/api" />;
  if (isTauri()) return renderHost({ kind: 'device', apiBase: deviceSessionApiBase });
  if (route.kind === 'host') {
    return renderHost({ kind: 'existing', sessionId: route.sessionId, apiBase: appSettingsStore.apiBase });
  }
  return <LandingPage />;
}

function renderHost(target: HostTarget): React.ReactElement {
  if (hasLocalBackend()) {
    appSettingsPresenter.setLocalBackend('starting');
    void connectLocalBackend();
  }
  const provisioningPresenter = new ProvisioningPresenter(new ProvisioningStore(), new HttpProvisioningSource());
  // Start once at boot (not in a component effect) so a StrictMode re-mount can't
  // trigger a second provisioning run.
  provisioningPresenter.start();
  const hostPageStore = new HostPageStore();
  void new HostPagePresenter(hostPageStore, target).start();
  const updatesStore = new UpdatesStore();
  const updatesPresenter = new UpdatesPresenter(updatesStore);
  if (isTauri()) void updatesPresenter.start();
  return (
    <SettingsModalProvider>
      <UpdatesStoreContext.Provider value={updatesStore}>
        <UpdatesPresenterContext.Provider value={updatesPresenter}>
          <HostPage store={hostPageStore} />
        </UpdatesPresenterContext.Provider>
      </UpdatesStoreContext.Provider>
    </SettingsModalProvider>
  );
}

/** Desktop hosts on its own backend even when aligning on a remote one: phones join
 *  through this machine's LAN gateway. */
async function deviceSessionApiBase(): Promise<string> {
  if (!hasLocalBackend()) return appSettingsStore.apiBase;
  await when(() => appSettingsStore.localApiBase != null);
  return appSettingsStore.localApiBase ?? appSettingsStore.apiBase;
}

async function connectLocalBackend(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      appSettingsPresenter.setLocalApiBase(await invoke<string>('local_backend_api_base'));
      return;
    } catch (err) {
      if (attempt === 0) {
        appSettingsPresenter.setLocalBackend('failed');
        toastStore.showError(`The backend didn't start: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCAL_BACKEND_RETRY_MS));
    }
  }
}
