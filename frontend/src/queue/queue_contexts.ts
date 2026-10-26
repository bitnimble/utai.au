import React from 'react';
import type { QueuePresenter } from './queue_presenter';
import type { QueueStore } from './queue_store';

export const QueueStoreContext = React.createContext<QueueStore | null>(null);
export const QueuePresenterContext = React.createContext<QueuePresenter | null>(null);
