import { isTauri } from '@tauri-apps/api/core';
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'src/design_tokens.css';
import { ProvisioningPresenter } from 'src/provisioning/provisioning_presenter';
import { createProvisioningSource } from 'src/provisioning/provisioning_source';
import { ProvisioningStore } from 'src/provisioning/provisioning_store';
import { StartupGate } from 'src/provisioning/startup_gate';
import { parseRoute } from 'src/session/app_route';
import { HostPage, type HostTarget } from 'src/session/host_page';
import { LandingPage } from 'src/session/landing_page';
import { RemotePage } from 'src/session/remote/remote_page';
import { SettingsModalProvider } from 'src/settings/settings_modal_context';
import { ErrorBoundary } from 'src/ui/error_boundary/error_boundary';

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
  // The app hosts its own session; only the website offers create / join.
  if (isTauri()) return renderHost({ kind: 'device' });
  if (route.kind === 'host') return renderHost({ kind: 'existing', sessionId: route.sessionId });
  return <LandingPage />;
}

function renderHost(target: HostTarget): React.ReactElement {
  const provisioningStore = new ProvisioningStore();
  const provisioningPresenter = new ProvisioningPresenter(provisioningStore, createProvisioningSource());
  // Start once at boot (not in a component effect) so a StrictMode re-mount can't
  // trigger a second provisioning run; the presenter stops itself on ready/error.
  provisioningPresenter.start();
  return (
    <SettingsModalProvider>
      <StartupGate store={provisioningStore} presenter={provisioningPresenter}>
        <HostPage target={target} />
      </StartupGate>
    </SettingsModalProvider>
  );
}
