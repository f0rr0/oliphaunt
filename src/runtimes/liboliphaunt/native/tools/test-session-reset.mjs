#!/usr/bin/env node
// Compile the actual session-reset helper with fault-injected protocol replies.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform === 'win32') {
  console.log('SKIP: session-reset fixture requires a POSIX C compiler');
  process.exit(0);
}

const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = readFileSync(path.join(native, 'src/liboliphaunt_native.c'), 'utf8');
function between(source, start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert(begin >= 0 && finish > begin, `missing source boundary: ${start}`);
  return source.slice(begin, finish);
}
const reset = between(host, 'static int32_t reset_session_command(', 'static int32_t oliphaunt_detach_impl(');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-native-cleanup-'));
function check(name, source, extra = []) {
  const file = path.join(scratch, `${name}.c`);
  const executable = path.join(scratch, name);
  writeFileSync(file, source);
  execFileSync(process.env.CC || 'cc', [
    '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O2', '-Wall', '-Wextra', '-Werror',
    '-pthread', '-I', path.join(native, 'src'), file, ...extra, '-o', executable,
  ], {stdio: 'inherit'});
  execFileSync(executable, [], {stdio: 'inherit'});
}
try {
  check('session-reset', `
#include "liboliphaunt_internal.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>
static int failure;
void oliphaunt_set_error(OliphauntHandle *h, const char *s) {
  snprintf(h->last_error, sizeof(h->last_error), "%s", s);
}
int32_t oliphaunt_exec_simple_query(OliphauntHandle *h, const char *sql,
                                   size_t len, OliphauntResponse *out) {
  if (failure == 1) { oliphaunt_set_error(h, "transport failed"); return -1; }
  size_t body = len + 1;
  out->len = 5 + body + 6;
  out->data = calloc(1, out->len);
  assert(out->data);
  out->data[0] = failure == 2 ? 'E' : 'C';
  out->data[4] = (unsigned char)(body + 4);
  memcpy(out->data + 5, sql, body);
  if (failure == 3) out->data[5] = '?';
  memcpy(out->data + 5 + body, "Z\\0\\0\\0\\5I", 6);
  h->transaction_status = failure == 4 ? 'E' : 'I';
  return 0;
}
void oliphaunt_free_response(OliphauntResponse *response) {
  free(response->data); response->data = NULL; response->len = 0;
}
${reset}
int main(void) {
  OliphauntHandle h = {0};
  const char *commands[] = {"ROLLBACK", "DISCARD ALL"};
  for (size_t i = 0; i < 2; i++) {
    for (failure = 0; failure <= 4; failure++) {
      h.last_error[0] = 0;
      assert((reset_session_command(&h, commands[i]) == 0) == (failure == 0));
      if (failure) assert(h.last_error[0]);
      if (failure == 1) assert(strcmp(h.last_error, "transport failed") == 0);
    }
  }
  puts("native reset command validation passed");
}
`, [path.join(native, 'src/liboliphaunt_backup_state.c')]);

} finally {
  rmSync(scratch, {recursive: true, force: true});
}
