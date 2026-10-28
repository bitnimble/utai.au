import { expect, test } from 'bun:test';
import { parseBlocks, parseInline } from '../release_notes_markdown';

test('parseBlocks splits headings, paragraphs and lists, joining wrapped bullets', () => {
  const markdown = [
    '### New',
    '',
    '- Queue songs for the next',
    '  singer',
    '- Join a session',
    '',
    'Thanks to',
    'everyone.',
    '### Fixed',
    '- Lyrics stay in time',
  ].join('\n');
  expect(parseBlocks(markdown)).toEqual([
    { kind: 'heading', text: 'New' },
    { kind: 'list', items: ['Queue songs for the next singer', 'Join a session'] },
    { kind: 'paragraph', text: 'Thanks to everyone.' },
    { kind: 'heading', text: 'Fixed' },
    { kind: 'list', items: ['Lyrics stay in time'] },
  ]);
});

test('parseBlocks reads CRLF line endings', () => {
  expect(parseBlocks('### New\r\n\r\n- Join a session\r\n')).toEqual([
    { kind: 'heading', text: 'New' },
    { kind: 'list', items: ['Join a session'] },
  ]);
});

test('parseInline keeps only https links, and matches a linked URL once', () => {
  expect(parseInline('see [the notes](https://utai.au/notes) or https://utai.au')).toEqual([
    { kind: 'text', text: 'see ' },
    { kind: 'link', label: 'the notes', href: 'https://utai.au/notes' },
    { kind: 'text', text: ' or ' },
    { kind: 'link', label: 'https://utai.au', href: 'https://utai.au' },
  ]);
  expect(parseInline('[click](javascript:alert(1))')).toEqual([
    { kind: 'text', text: 'click' },
    { kind: 'text', text: ')' },
  ]);
  expect(parseInline('[plain](http://utai.au) http://utai.au')).toEqual([
    { kind: 'text', text: 'plain' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: 'http://utai.au' },
  ]);
});

test('parseInline reads code and bold', () => {
  expect(parseInline('run `bun` **now**')).toEqual([
    { kind: 'text', text: 'run ' },
    { kind: 'code', text: 'bun' },
    { kind: 'text', text: ' ' },
    { kind: 'bold', text: 'now' },
  ]);
});
