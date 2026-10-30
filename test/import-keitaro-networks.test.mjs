import test from 'node:test';
import assert from 'node:assert/strict';
import { mapNetwork } from '../scripts/import-keitaro-networks.mjs';

test('Keitaro network → Umbrella: click id param from {subid}, macros converted, unknown ones reported', () => {
  const { network, notes } = mapNetwork({ id: 23, name: 'пп1', offer_param: 'source_id={campaign_id}&sub1={subid}&sub10={sub_id_10}&x={os}' });
  assert.deepEqual(network, { id: 'kt-net-23', name: 'пп1', offerParams: 'source_id={campaign}&sub1={click_id}&sub10={sub_id_10}&x=',
    clickIdParam: 'sub1', payoutParam: 'payout', notes: 'Импорт из Keitaro #23' });
  assert.ok(notes.some((n) => n.includes('{os}')));
  assert.ok(notes.some((n) => n.includes('{payout}')));
});

test('Keitaro network without {subid}: falls back to sub1 and says so', () => {
  const { network, notes } = mapNetwork({ id: 5, name: 'X', offer_param: '' });
  assert.equal(network.clickIdParam, 'sub1');
  assert.ok(notes.some((n) => n.includes('Click ID')));
});
