import React from 'react';
import { MusicSourcePresenter } from './music_source_presenter';
import { MusicSourceStore } from './music_source_store';

/** Routes the {@link MusicSourceStore} (music-source data) to the view. */
export const MusicSourceStoreContext = React.createContext<MusicSourceStore | null>(null);

/** Routes the {@link MusicSourcePresenter} (all mutations) to the view. */
export const MusicSourcePresenterContext = React.createContext<MusicSourcePresenter | null>(null);
