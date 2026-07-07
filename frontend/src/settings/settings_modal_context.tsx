import React from 'react';

export type SettingsTab = 'sources' | 'audio';

type SettingsModalApi = {
  open: boolean;
  tab: SettingsTab;
  /** Open the dialog, optionally jumping straight to a tab. */
  openSettings: (tab?: SettingsTab) => void;
  close: () => void;
  setTab: (tab: SettingsTab) => void;
};

const SettingsModalContext = React.createContext<SettingsModalApi | null>(null);

/**
 * Global settings-dialog state (open + active tab) exposed via context so any
 * component can open Settings without prop-drilling. Plain React (transient UI
 * state, not persisted), mirroring the app's modal-manager convention. Wrap the
 * app once; consume with {@link useSettingsModal}.
 */
export const SettingsModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<SettingsTab>('sources');

  const api = React.useMemo<SettingsModalApi>(
    () => ({
      open,
      tab,
      openSettings: (t) => {
        if (t) setTab(t);
        setOpen(true);
      },
      close: () => setOpen(false),
      setTab,
    }),
    [open, tab],
  );

  return <SettingsModalContext.Provider value={api}>{children}</SettingsModalContext.Provider>;
};

export function useSettingsModal(): SettingsModalApi {
  const ctx = React.useContext(SettingsModalContext);
  if (ctx == null) throw new Error('useSettingsModal must be used within a SettingsModalProvider');
  return ctx;
}
