export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

export type Segment =
  | { kind: 'text' | 'code' | 'bold'; text: string }
  | { kind: 'link'; label: string; href: string };

/** The markdown a changelog uses: headings, bullets (wrapped or not) and paragraphs. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    if (bullets.length > 0) blocks.push({ kind: 'list', items: bullets });
    paragraph = [];
    bullets = [];
  };

  // A body edited on GitHub comes back with CRLF.
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading != null) {
      flush();
      blocks.push({ kind: 'heading', text: heading[1] });
    } else if (bullet != null) {
      if (paragraph.length > 0) flush();
      bullets.push(bullet[1]);
    } else if (line.trim() === '') {
      flush();
    } else if (bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

// One alternation, so a URL already inside a link isn't matched a second time as a bare one.
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g;

/** Links, code and bold within a line. A link that isn't https is text: it would run inside the app. */
export function parseInline(text: string): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, label, href, code, bold, bare] = match;
    const index = match.index ?? 0;
    if (index > at) segments.push({ kind: 'text', text: text.slice(at, index) });
    if (code != null) segments.push({ kind: 'code', text: code });
    else if (bold != null) segments.push({ kind: 'bold', text: bold });
    else {
      const url = href ?? bare;
      const shown = label ?? bare;
      segments.push(/^https:\/\//i.test(url) ? { kind: 'link', label: shown, href: url } : { kind: 'text', text: shown });
    }
    at = index + whole.length;
  }
  if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) });
  return segments;
}
