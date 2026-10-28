import React from 'react';
import type { UpdatesPresenter } from './updates_presenter';
import type { UpdatesStore } from './updates_store';

export const UpdatesStoreContext = React.createContext<UpdatesStore | null>(null);
export const UpdatesPresenterContext = React.createContext<UpdatesPresenter | null>(null);
