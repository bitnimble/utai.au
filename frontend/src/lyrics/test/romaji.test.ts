import { describe, expect, test } from 'bun:test';
import { kanaToRomaji } from '../romaji';

describe('kanaToRomaji', () => {
  test('plain syllables, Hepburn spellings', () => {
    expect(kanaToRomaji('きみ')).toBe('kimi');
    expect(kanaToRomaji('しちつふじ')).toBe('shichitsufuji');
    expect(kanaToRomaji('を')).toBe('o');
  });

  test('digraphs and katakana', () => {
    expect(kanaToRomaji('きょう')).toBe('kyou');
    expect(kanaToRomaji('しゃしん')).toBe('shashin');
    expect(kanaToRomaji('チョコ')).toBe('choko');
    expect(kanaToRomaji('ファン')).toBe('fan');
  });

  test('sokuon doubles the next consonant', () => {
    expect(kanaToRomaji('いった')).toBe('itta');
    expect(kanaToRomaji('まっちゃ')).toBe('matcha');
    expect(kanaToRomaji('がっこう')).toBe('gakkou');
  });

  test('long-vowel mark repeats the vowel', () => {
    expect(kanaToRomaji('ストーリー')).toBe('sutoorii');
  });

  test('ん before a vowel or y gets an apostrophe', () => {
    expect(kanaToRomaji('れんあい')).toBe("ren'ai");
    expect(kanaToRomaji('こんや')).toBe("kon'ya");
    expect(kanaToRomaji('ほんとう')).toBe('hontou');
  });

  test('passes through non-kana', () => {
    expect(kanaToRomaji('ABC、!')).toBe('ABC、!');
  });
});
