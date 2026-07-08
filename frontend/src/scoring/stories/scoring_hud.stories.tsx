import type { Meta, StoryObj } from '@storybook/react-vite';
import { runInAction } from 'mobx';
import React from 'react';
import { FakeLivePitchSource } from '../live_pitch_source';
import type { NoteResult } from '../scoring';
import { ScoringPresenterContext, ScoringStoreContext } from '../scoring_contexts';
import { ScoringControls } from '../scoring_hud';
import { ScoringPresenter, type ScoringClock } from '../scoring_presenter';
import { ScoringStore } from '../scoring_store';

/**
 * The transport-bar scoring HUD, rendered standalone across its states from a
 * hand-populated store (no mic / model / transport). Exercises the difficulty
 * picker, the live pitch meter (target vs sung + cents needle, green on-pitch),
 * and the running/final score readout. The start button is disabled here since
 * a story has no loaded track.
 */
const idleClock: ScoringClock = { currentTime: 0, isPlaying: false };

function harness(fill: (store: ScoringStore) => void): React.ReactElement {
  const store = new ScoringStore();
  const presenter = new ScoringPresenter(store, new FakeLivePitchSource(), idleClock, () => []);
  runInAction(() => fill(store));
  return (
    <ScoringStoreContext.Provider value={store}>
      <ScoringPresenterContext.Provider value={presenter}>
        <div style={{ display: 'flex', padding: 16 }}>
          <ScoringControls />
        </div>
      </ScoringPresenterContext.Provider>
    </ScoringStoreContext.Provider>
  );
}

function note(startSec: number, endSec: number, score: number): NoteResult {
  return {
    target: { startSec, endSec, midi: 60 },
    scored: true,
    score,
    pitchScore: score,
    octaveFactor: 1,
    coverage: 1,
    expression: 1,
    octaveOffset: 0,
    errorCents: 0,
  };
}

const meta: Meta = {
  title: 'Scoring/HUD',
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj;

export const Idle: Story = { render: () => harness(() => {}) };

export const SingingOnPitch: Story = {
  render: () =>
    harness((s) => {
      s.active = true;
      s.currentTargetMidi = 62;
      s.currentPitch = { tSec: 12, midi: 62.1, confidence: 0.95 };
      s.noteResults = [note(0, 1, 1), note(1, 2, 0.9)];
    }),
};

export const SingingFlat: Story = {
  render: () =>
    harness((s) => {
      s.active = true;
      s.currentTargetMidi = 62;
      s.currentPitch = { tSec: 12, midi: 61.1, confidence: 0.9 }; // ~90 cents flat
      s.noteResults = [note(0, 1, 0.8), note(1, 2, 0.5)];
    }),
};

export const Finished: Story = {
  render: () =>
    harness((s) => {
      s.noteResults = [note(0, 1, 1), note(1, 2, 0.85), note(2, 3.5, 0.7)];
    }),
};
