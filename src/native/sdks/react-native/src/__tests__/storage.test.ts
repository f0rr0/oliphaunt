import { expect, test } from 'bun:test';
import { directory, applicationData } from '../storage';

test('directory accepts native paths and decodes local filesystem URIs once', () => {
  expect(directory('/data/my db')).toEqual({ kind: 'directory', path: '/data/my db' });
  expect(directory('file:///data/my%20db')).toEqual(directory('/data/my db'));
  expect(directory('file:///data/a%2520b').path).toBe('/data/a%20b');
  expect(Object.isFrozen(directory('/data/db'))).toBe(true);
});

test('directory rejects non-local resources and malformed file URIs', () => {
  for (const input of [
    '',
    ' ',
    'relative/db',
    './db',
    '../db',
    '/data/\0db',
    'file:///data/%00db',
    'file://remote/db',
    'https://example.com/db',
    'content://files/db',
    'file:///db?q=1',
    'file:///db#fragment',
    'file:///data%2fdb',
    'file:///data%5cdb',
    'file:///bad%',
  ]) {
    expect(() => directory(input), input).toThrow();
  }
});

test('applicationData validates and freezes the portable storage name', () => {
  expect(applicationData(' primary ')).toEqual({ kind: 'applicationData', name: 'primary' });
  expect(Object.isFrozen(applicationData('primary'))).toBe(true);
  for (const name of ['', '.', '..', '../db', '/data/db', 'a/b', 'a\\b', 'a'.repeat(129)]) {
    expect(() => applicationData(name)).toThrow();
  }
});
