import type { Meta, StoryObj } from '@storybook/react-vite';
import { runInAction } from 'mobx';
import React from 'react';
import type { ReleaseNote } from '../releases';
import { UpdatesPresenterContext, UpdatesStoreContext } from '../updates_contexts';
import { UpdatesPresenter, type UpdateShell } from '../updates_presenter';
import { UpdatesSettings } from '../updates_settings';
import { UpdatesStore } from '../updates_store';

const shell: UpdateShell = {
  isAndroid: false,
  version: async () => '0.1.4',
  canInstall: async () => true,
  install: () => new Promise(() => {}),
  open: async () => {},
};

const NOTES: ReleaseNote[] = [
  {
    version: '0.1.6',
    notes: '### New\n\n- Navigate the app with a TV remote\n\n### Fixed\n\n- Escape closes the open dialog',
    url: 'https://github.com/bitnimble/utai.au/releases/tag/v0.1.6',
    apkUrl: null,
  },
  {
    version: '0.1.5',
    notes: '### Improved\n\n- Lyrics stay in time after a seek, see [the notes](https://utai.au)',
    url: 'https://github.com/bitnimble/utai.au/releases/tag/v0.1.5',
    apkUrl: null,
  },
];

function harness(fill: (store: UpdatesStore) => void): React.ReactElement {
  const store = new UpdatesStore();
  const presenter = new UpdatesPresenter(store, shell, async () => []);
  runInAction(() => {
    store.current = '0.1.4';
    store.canInstall = true;
    store.checkedAt = new Date(2026, 9, 28, 14, 5);
    fill(store);
  });
  return (
    <UpdatesStoreContext.Provider value={store}>
      <UpdatesPresenterContext.Provider value={presenter}>
        <div style={{ width: 620 }}>
          <UpdatesSettings />
        </div>
      </UpdatesPresenterContext.Provider>
    </UpdatesStoreContext.Provider>
  );
}

const meta: Meta = {
  title: 'Updates/Settings',
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj;

export const UpToDate: Story = { render: () => harness(() => {}) };

export const Available: Story = { render: () => harness((s) => (s.newer = NOTES)) };

export const DownloadOnly: Story = {
  render: () =>
    harness((s) => {
      s.newer = NOTES;
      s.canInstall = false;
    }),
};

export const Downloading: Story = {
  render: () =>
    harness((s) => {
      s.newer = NOTES;
      s.install = 'downloading';
      s.downloaded = 40;
      s.total = 100;
    }),
};

export const Restarting: Story = {
  render: () =>
    harness((s) => {
      s.newer = NOTES;
      s.install = 'restarting';
    }),
};

export const Failed: Story = {
  render: () =>
    harness((s) => {
      s.newer = NOTES;
      s.error = "Couldn't install the update: signature mismatch";
    }),
};
