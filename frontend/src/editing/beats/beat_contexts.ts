import React from 'react';
import { BeatStore } from './beat_store';

/** Routes the {@link BeatStore} to the beat-line overlay mounted in each
 *  audio + lyrics track's bars row, and to the toolbar BPM/time-sig readout.
 *  `null` outside the view. */
export const BeatStoreContext = React.createContext<BeatStore | null>(null);
