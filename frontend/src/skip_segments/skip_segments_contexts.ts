import React from 'react';
import type { SkipSegmentsPresenter } from './skip_segments_presenter';
import type { SkipSegmentsStore } from './skip_segments_store';

export const SkipSegmentsStoreContext = React.createContext<SkipSegmentsStore | null>(null);
export const SkipSegmentsPresenterContext = React.createContext<SkipSegmentsPresenter | null>(null);
