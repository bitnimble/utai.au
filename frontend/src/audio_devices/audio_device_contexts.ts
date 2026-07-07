import React from 'react';
import type { AudioDevicePresenter } from './audio_device_presenter';
import type { AudioDeviceStore } from './audio_device_store';

export const AudioDeviceStoreContext = React.createContext<AudioDeviceStore | null>(null);
export const AudioDevicePresenterContext = React.createContext<AudioDevicePresenter | null>(null);
