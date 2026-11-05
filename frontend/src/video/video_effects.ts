export const VIDEO_EFFECTS = ['none', 'crt', 'vhs', 'film', 'pixel'] as const;
export type VideoEffect = (typeof VIDEO_EFFECTS)[number];
export type ShadedVideoEffect = Exclude<VideoEffect, 'none'>;
