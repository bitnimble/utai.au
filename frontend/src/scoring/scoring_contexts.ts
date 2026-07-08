import React from 'react';
import type { ScoringPresenter } from './scoring_presenter';
import type { ScoringStore } from './scoring_store';

export const ScoringStoreContext = React.createContext<ScoringStore | null>(null);
export const ScoringPresenterContext = React.createContext<ScoringPresenter | null>(null);
