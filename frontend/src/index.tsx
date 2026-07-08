import React from 'react';
import { createRoot } from 'react-dom/client';
import 'src/design_tokens.css';
import { KaraokePage } from 'src/karaoke/karaoke_page';
import { ProvisioningPresenter } from 'src/provisioning/provisioning_presenter';
import { createProvisioningSource } from 'src/provisioning/provisioning_source';
import { ProvisioningStore } from 'src/provisioning/provisioning_store';
import { StartupGate } from 'src/provisioning/startup_gate';
import { SettingsModalProvider } from 'src/settings/settings_modal_context';
import { ErrorBoundary } from 'src/ui/error_boundary/error_boundary';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount element');

const provisioningStore = new ProvisioningStore();
const provisioningPresenter = new ProvisioningPresenter(provisioningStore, createProvisioningSource());
// Start once at boot (not in a component effect) so a StrictMode re-mount can't
// trigger a second provisioning run; the presenter stops itself on ready/error.
provisioningPresenter.start();

createRoot(container).render(
  <ErrorBoundary>
    <React.StrictMode>
      <SettingsModalProvider>
        <StartupGate store={provisioningStore} presenter={provisioningPresenter}>
          <KaraokePage />
        </StartupGate>
      </SettingsModalProvider>
    </React.StrictMode>
  </ErrorBoundary>,
);
