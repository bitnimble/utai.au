import { invoke, isTauri } from '@tauri-apps/api/core';
import { when } from 'mobx';
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'src/design_tokens.css';
import { pageLog } from 'src/log_viewer/page_log';
import { ProvisioningPresenter } from 'src/provisioning/provisioning_presenter';
import { createProvisioningSource } from 'src/provisioning/provisioning_source';
import { ProvisioningStore } from 'src/provisioning/provisioning_store';
import { StartupGate } from 'src/provisioning/startup_gate';
import { parseRoute } from 'src/session/app_route';
import { HostPage } from 'src/session/host_page';
import { HostPagePresenter, type HostTarget } from 'src/session/host_page_presenter';
import { HostPageStore } from 'src/session/host_page_store';
import { LandingPage } from 'src/session/landing_page';
import { RemotePage } from 'src/session/remote/remote_page';
import { isSidecarAvailable } from 'src/net/sidecar_transport';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import { SettingsModalProvider } from 'src/settings/settings_modal_context';
import { ErrorBoundary } from 'src/ui/error_boundary/error_boundary';
import { toastStore } from 'src/ui/toasts/toasts';

pageLog.follow();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount element');

createRoot(container).render(
  <ErrorBoundary>
    <React.StrictMode>{renderRoute()}</React.StrictMode>
  </ErrorBoundary>,
);

function renderRoute(): React.ReactElement {
  const route = parseRoute(window.location.pathname);
  // The remote is served by the session relay itself, so its API is always this origin's.
  if (route.kind === 'remote') return <RemotePage sessionId={route.sessionId} apiBase="/api" />;
  if (isTauri()) return renderHost({ kind: 'device', apiBase: deviceSessionApiBase });
  if (route.kind === 'host') {
    return renderHost({ kind: 'existing', sessionId: route.sessionId, apiBase: appSettingsStore.apiBase });
  }
  return <LandingPage />;
}

function renderHost(target: HostTarget): React.ReactElement {
  const provisioningStore = new ProvisioningStore();
  const provisioningPresenter = new ProvisioningPresenter(provisioningStore, createProvisioningSource());
  // Start once at boot (not in a component effect) so a StrictMode re-mount can't
  // trigger a second provisioning run; the presenter stops itself on ready/error.
  provisioningPresenter.start();
  const hostPageStore = new HostPageStore();
  void new HostPagePresenter(hostPageStore, target).start();
  // Provisioning syncs the venv the local backend runs from.
  if (isSidecarAvailable()) when(() => provisioningStore.state === 'ready', connectLocalBackend);
  return (
    <SettingsModalProvider>
      <StartupGate store={provisioningStore} presenter={provisioningPresenter}>
        <HostPage store={hostPageStore} />
      </StartupGate>
    </SettingsModalProvider>
  );
}

function deviceSessionApiBase(): Promise<string> {
  return isSidecarAvailable() ? invoke<string>('session_server_api_base') : Promise.resolve(appSettingsStore.apiBase);
}

async function connectLocalBackend(): Promise<void> {
  try {
    appSettingsPresenter.setLocalApiBase(await invoke<string>('local_backend_api_base'));
  } catch (err) {
    toastStore.showError(`Music search and downloads are unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
