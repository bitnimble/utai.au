import React from 'react';
import type { VideoPresenter } from './video_presenter';
import type { VideoStore } from './video_store';

export const VideoStoreContext = React.createContext<VideoStore | null>(null);
export const VideoPresenterContext = React.createContext<VideoPresenter | null>(null);
