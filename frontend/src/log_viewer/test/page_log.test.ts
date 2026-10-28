import { expect, test } from 'bun:test';
import { PageLog } from '../page_log';

test('a line is an ISO timestamp, a padded level, then every argument', () => {
  const log = new PageLog();
  log.record('WARN', ['fetch failed', { status: 503 }, new Error('boom')]);
  const [line] = log.recent();
  expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z WARN  fetch failed \{"status":503\} Error: boom/);
});

test('keeps the newest 2000 lines', () => {
  const log = new PageLog();
  for (let i = 0; i < 2005; i++) log.record('INFO', [`line ${i}`]);
  expect(log.recent()).toHaveLength(2000);
  expect(log.recent()[0]).toEndWith('line 5');
  expect(log.recent().at(-1)).toEndWith('line 2004');
});
