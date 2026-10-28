import { expect, test } from 'bun:test';
import { nearest, type Box } from '../remote_navigation';

const box = (left: number, top: number, width = 40, height = 20): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

test('picks the closest box that way, weighing sideways offset double', () => {
  const from = box(100, 100);
  const boxes = [box(160, 100), box(150, 160), box(300, 100), box(20, 100)];
  expect(nearest(from, boxes, 'right')).toBe(0);
  expect(nearest(from, boxes, 'left')).toBe(3);
  expect(nearest(from, boxes, 'down')).toBe(1);
});

test('nothing behind counts, beyond a couple of pixels of overlap', () => {
  const from = box(100, 100);
  expect(nearest(from, [box(20, 100), box(100, 40)], 'right')).toBeNull();
  expect(nearest(from, [box(139, 100)], 'right')).toBe(0);
  expect(nearest(from, [], 'up')).toBeNull();
});

test('a box straight ahead beats a nearer one far off to the side', () => {
  const from = box(100, 100);
  const aside = box(150, 300);
  const ahead = box(400, 100);
  expect(nearest(from, [aside, ahead], 'right')).toBe(1);
});
