import React from 'react';
import styles from './release_notes.module.css';

/**
 * A release's markdown changelog.
 *
 * ponytail: only the markdown a changelog uses (headings, bullets, links, code, bold) rather than
 * a markdown dependency plus the sanitiser it would need. Every value ends up as a text node or an
 * https href, so a release note is inert whatever it says.
 */
export function ReleaseNotes({ markdown }: { markdown: string }): React.ReactElement {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={blocks.length} className={styles.para}>
        {inline(paragraph.join(' '))}
      </p>,
    );
    paragraph = [];
  };

  const flushList = (): void => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={blocks.length} className={styles.list}>
        {bullets.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading != null) {
      flushParagraph();
      flushList();
      blocks.push(
        <div key={blocks.length} className={styles.heading}>
          {inline(heading[1])}
        </div>,
      );
    } else if (bullet != null) {
      flushParagraph();
      bullets.push(bullet[1]);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();

  return <div className={styles.notes}>{blocks}</div>;
}

// Alternation rather than four passes, so a URL already inside a link isn't matched twice.
const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+)/g;

function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, label, href, code, bold, bare] = match;
    const index = match.index ?? 0;
    if (index > at) parts.push(text.slice(at, index));
    if (code != null) parts.push(<code key={index}>{code}</code>);
    else if (bold != null) parts.push(<strong key={index}>{bold}</strong>);
    else parts.push(<Link key={index} href={href ?? bare} label={label ?? bare} />);
    at = index + whole.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

function Link({ href, label }: { href: string; label: string }): React.ReactElement {
  // A `javascript:` href would run script inside the app.
  if (!/^https:\/\//i.test(href)) return <>{label}</>;
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  );
}
