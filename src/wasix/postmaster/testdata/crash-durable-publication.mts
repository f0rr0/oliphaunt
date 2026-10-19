#!/usr/bin/env bun
import * as fs from 'node:fs';
import { spyOn } from 'bun:test';
import { run } from '../lib/durable-publication.mts';
const [point, source, destination] = process.argv.slice(2);
const sync = fs.fsyncSync,
  link = fs.linkSync,
  unlink = fs.unlinkSync;
const crash = () => process.kill(process.pid, 'SIGKILL');
let syncs = 0;
spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
  sync(fd);
  if (
    ['source-fsync', 'destination-fsync', 'commit-directory-fsync', 'cleanup-directory-fsync'][
      syncs++
    ] === point
  )
    crash();
});
spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
  link(source, destination);
  if (point === 'link') crash();
});
spyOn(fs, 'unlinkSync').mockImplementation((path) => {
  unlink(path);
  if (point === 'source-unlink') crash();
});
await run(['publish', source, destination]);
throw Error('publication did not hit the requested crash point');
