import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCampaign } from '../scripts/import-keitaro-campaigns.mjs';

const campaign = { id: 4982, alias: 'foodiflex-promo', name: '[Angry] Ninja', type: 'position', cookies_ttl: 24, cost_type: 'CPC', cost_value: 0,
  domain: 'https://ninja-promo.cc/', parameters: { external_id: { name: 'fbclid' }, ad_campaign_id: { name: 'utm_campaign' }, cost: { name: 'cost' }, keyword: { name: 'keyword' } } };
const streams = [
  { name: 'Fallback', type: 'default', position: 2, state: 'active', schema: 'redirect', action_payload: 'https://www.sharkninja.fr/?s={subid}&x={os}', filters: [] },
  { name: 'Main', type: 'regular', position: 1, weight: 100, state: 'active', schema: 'landings', filters: [{ name: 'country', mode: 'accept', payload: ['fr'] }, { name: 'device_type', mode: 'accept', payload: ['mobile'] }],
    offers: [{ offer_id: 313, share: 70, state: 'active' }, { offer_id: 314, share: 30, state: 'active' }], landings: [{ landing_id: 2809, share: 100 }] },
  { name: 'Not US', type: 'regular', position: 3, state: 'active', schema: 'offers', filters: [{ name: 'country', mode: 'reject', payload: ['US'] }], offers: [{ offer_id: 313, share: 100 }] },
  { name: 'Off', type: 'forced', position: 4, state: 'disabled', schema: 'redirect', action_payload: 'https://example.com/' },
];

test('Keitaro campaign → Umbrella: streams, filters, params, cost; landings and reject filters are reported, not copied', () => {
  const { campaign: c, notes } = mapCampaign(campaign, streams, { 'kt-313': {}, 'kt-314': {} });
  assert.equal(c.id, 'foodiflex-promo', 'alias keeps the /r/<alias> link');
  assert.equal(c.active, false, 'imported campaigns start disabled');
  assert.equal(c.streamRotation, 'position');
  assert.deepEqual(c.paramMap, { external_id: 'fbclid', ad_campaign_id: 'utm_campaign' });
  assert.deepEqual([c.costModel, c.costFromParam], ['cpc', true]);
  assert.equal(c.streams.length, 2, 'reject-filter and disabled streams are skipped');
  assert.deepEqual(c.streams[0], { name: 'Main', type: 'regular', weight: 100, conditions: { countries: ['FR'], devices: ['mobile'] },
    offers: [{ offerId: 'kt-313', weight: 70 }, { offerId: 'kt-314', weight: 30 }] });
  assert.deepEqual(c.streams[1], { name: 'Fallback', type: 'fallback', conditions: {}, action: 'url', url: 'https://www.sharkninja.fr/?s={click_id}&x=' });
  for (const part of ['лендинг не перенесён', 'reject', 'выключен', 'домен Keitaro', '{os}']) assert.ok(notes.some((n) => n.includes(part)), `note about ${part}`);
});

test('Keitaro campaign → Umbrella: missing offers are reported and the stream is skipped', () => {
  const { campaign: c, notes } = mapCampaign({ ...campaign, alias: '' }, [streams[1]], { 'kt-313': {} });
  assert.equal(c.id, 'kt-c4982', 'no usable alias → kt-c<id>');
  assert.equal(c.streams.length, 0);
  assert.ok(notes.some((n) => n.includes('kt-314') && n.includes('--ids 314')));
});
