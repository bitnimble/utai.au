import React from 'react';
import { parseBlocks, parseInline } from './release_notes_markdown';
import styles from './release_notes.module.css';

export function ReleaseNotes({
  markdown,
  onOpen,
}: {
  markdown: string;
  onOpen: (url: string) => void;
}): React.ReactElement {
  const inline = (text: string): React.ReactNode[] =>
    parseInline(text).map((segment, i) => {
      switch (segment.kind) {
        case 'text':
          return <React.Fragment key={i}>{segment.text}</React.Fragment>;
        case 'code':
          return <code key={i}>{segment.text}</code>;
        case 'bold':
          return <strong key={i}>{segment.text}</strong>;
        case 'link':
          return (
            <a
              key={i}
              className={styles.link}
              href={segment.href}
              onClick={(e) => {
                // The webview won't open a new window itself; the shell opens the browser.
                e.preventDefault();
                onOpen(segment.href);
              }}
            >
              {segment.label}
            </a>
          );
      }
    });

  return (
    <div className={styles.notes}>
      {parseBlocks(markdown).map((block, i) => {
        if (block.kind === 'heading') {
          return (
            <div key={i} className={styles.heading}>
              {inline(block.text)}
            </div>
          );
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={i} className={styles.para}>
              {inline(block.text)}
            </p>
          );
        }
        return (
          <ul key={i} className={styles.list}>
            {block.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}
