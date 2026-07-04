import React from 'react';
import { StructuralPresenter } from './structure/structural_presenter';

/**
 * Routes the {@link StructuralPresenter} (geometry + zoom scale + the
 * linear timeline) to the lyrics + waveform rows. `null` outside the view.
 */
export const StructuralContext = React.createContext<StructuralPresenter | null>(null);
