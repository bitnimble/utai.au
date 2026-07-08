/** Extract the 11-char YouTube video id from a watch / short / embed / music
 *  URL ("youtube.com/watch?v=ID", "music.youtube.com/watch?v=ID",
 *  "youtu.be/ID", "youtube.com/embed/ID", "/shorts/ID"). undefined for a
 *  non-YouTube or unparseable URL, so a non-YouTube source simply gets no
 *  embedded video. */
export function parseYouTubeId(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return isValidId(id) ? id : undefined;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') {
    const v = u.searchParams.get('v');
    if (v && isValidId(v)) return v;
    const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/);
    if (m && isValidId(m[1])) return m[1];
  }
  return undefined;
}

function isValidId(id: string): boolean {
  return /^[\w-]{11}$/.test(id);
}
