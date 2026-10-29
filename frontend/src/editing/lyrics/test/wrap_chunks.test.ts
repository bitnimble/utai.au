import { describe, expect, test } from 'bun:test';
import { wrapChunks } from '../wrap_chunks';

describe('wrapChunks', () => {
  test('splits Latin at whitespace, keeping trailing punctuation and quotes on their word', () => {
    expect(wrapChunks('Hello,  "world" don\'t stop!')).toEqual(['Hello,', '  ', '"world"', ' ', "don't", ' ', 'stop!']);
  });

  test('splits CJK between words, opening brackets leading and closing ones trailing', () => {
    expect(wrapChunks('「君の名は」。')).toEqual(['「君', 'の', '名', 'は」。']);
  });

  test('keeps a lone word whole', () => {
    expect(wrapChunks('レディ')).toEqual(['レディ']);
    expect(wrapChunks('')).toEqual([]);
  });
});
