import test from 'node:test';
import { runCapCases } from './caps-cases.mjs';

test('JSONL: click caps and deduplication hold under 50 concurrent clicks', { timeout: 60000 }, (t) => runCapCases(t));
