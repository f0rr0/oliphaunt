import { mock } from 'bun:test';
import * as runtime from './runtime-carrier.js';

mock.module('@oliphaunt/liboliphaunt-wasix', () => runtime);
