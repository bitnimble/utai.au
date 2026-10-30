import React from 'react';
import type { FullscreenPresenter } from './fullscreen_presenter';
import type { FullscreenStore } from './fullscreen_store';

export const FullscreenStoreContext = React.createContext<FullscreenStore | null>(null);

export const FullscreenPresenterContext = React.createContext<FullscreenPresenter | null>(null);
