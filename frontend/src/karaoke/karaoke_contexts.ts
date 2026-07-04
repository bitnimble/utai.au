import React from 'react';
import { KaraokePresenter } from './karaoke_presenter';
import { SongStore } from './song_store';

/** Routes the {@link KaraokePresenter} (all mutations) to the view. */
export const KaraokePresenterContext = React.createContext<KaraokePresenter | null>(null);

/** Routes the {@link SongStore} (loaded-song data) to the view. */
export const SongStoreContext = React.createContext<SongStore | null>(null);
