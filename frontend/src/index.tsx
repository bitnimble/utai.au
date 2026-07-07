import React from 'react';
import { createRoot } from 'react-dom/client';
import 'src/design_tokens.css';
import { KaraokePage } from 'src/karaoke/karaoke_page';
import { SettingsModalProvider } from 'src/settings/settings_modal_context';
import { ErrorBoundary } from 'src/ui/error_boundary/error_boundary';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount element');
createRoot(container).render(
  <ErrorBoundary>
    <React.StrictMode>
      <SettingsModalProvider>
        <KaraokePage />
      </SettingsModalProvider>
    </React.StrictMode>
  </ErrorBoundary>,
);
