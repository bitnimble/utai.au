import { SkipForward } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { SkipSegmentsPresenterContext, SkipSegmentsStoreContext } from './skip_segments_contexts';
import type { SkipCategory } from './sponsorblock';
import styles from './skip_segment_button.module.css';

const SKIP_LABELS: Record<SkipCategory, string> = {
  music_offtopic: 'Skip non-music',
  intro: 'Skip intro',
  outro: 'Skip outro',
  preview: 'Skip preview',
  sponsor: 'Skip sponsor',
  selfpromo: 'Skip promo',
  interaction: 'Skip reminder',
};

export const SkipSegmentButton = observer(function SkipSegmentButton() {
  const store = React.useContext(SkipSegmentsStoreContext)!;
  const presenter = React.useContext(SkipSegmentsPresenterContext)!;
  const segment = store.activeSegment;
  if (segment == null) return null;
  return (
    <button
      type="button"
      className={styles.skipButton}
      onClick={presenter.skipActive}
      title="Segment from SponsorBlock"
      data-testid="skip-segment"
    >
      {SKIP_LABELS[segment.category]}
      <SkipForward size={16} aria-hidden="true" />
    </button>
  );
});
