// Self-check: node test.mjs. Fails loudly if any planted exception is missed.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseExport, runChecks } from './checks.js';

const rows = readFileSync(new URL('./sample.csv', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
const parsed = parseExport(rows);
assert.ok(parsed.hasClr, 'Clr column detected');
assert.equal(parsed.txns.length, 28, 'transaction rows parsed');
assert.equal(parsed.txns[0].account, 'Checking', 'group header applied as account');

const { findings } = runChecks(parsed);
const by = Object.fromEntries(findings.map((f) => [f.id, f]));
const names = (id) => by[id].items.map((i) => i.name || i.num || i.memo);

assert.equal(by.obe.items.length, 1, 'OBE journal entry caught');
assert.deepEqual(names('negar'), ['Freeman Sporting Goods'], 'negative A/R customer');
assert.deepEqual(names('negap'), ['Norton Lumber'], 'negative A/P vendor');
assert.ok(by.dup.items.length === 2 && by.dup.items.every((i) => i.name === 'Hicks Hardware'), 'Hicks Hardware duplicate pair');
assert.ok(by.uf.items.some((i) => i.name === 'Dukes Basketball Camp'), 'old receipt in Undeposited Funds');
assert.ok(by.uf.items.some((i) => Math.abs(i.amount + 550) < 0.01), 'UF credit balance');
assert.deepEqual(by.stale.items.map((i) => i.num).sort(), ['1022', '1035'], 'two stale uncleared checks');
assert.equal(by.xfer.items.length, 1, 'transfer to Office Expenses');
assert.equal(by.uncat.items.length, 2, 'Uncategorized Expense + Ask My Accountant');
console.log('ok:', findings.map((f) => `${f.id}=${f.items.length}`).join(' '));
