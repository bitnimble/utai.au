import React from 'react';
import type { SessionHostPresenter } from './session_host_presenter';
import type { SessionHostStore } from './session_host_store';

export const SessionHostStoreContext = React.createContext<SessionHostStore | null>(null);
export const SessionHostPresenterContext = React.createContext<SessionHostPresenter | null>(null);
