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
  { name: 'Sources', type: 'regular', position: 5, state: 'active', schema: 'redirect', action_payload: 'https://src.example.net/', filters: [
    { name: 'referrer', mode: 'accept', payload: ['https://Facebook.com/ads'] }, { name: 'empty_referrer', mode: 'reject', payload: null },
    { name: 'keyword', mode: 'reject', payload: ['Spam'] }, { name: 'ip', mode: 'reject', payload: ['10.0.0.0/8', '1.2.3.1-1.2.3.9'] },
    { name: 'user_agent', mode: 'accept', payload: ['FBAN'] }, { name: 'interval', mode: 'accept', payload: { from: '2026-11-01 00:00', to: '2026-11-30', timezone: 'Europe/Paris' } }] },
  { name: 'Odd', type: 'regular', position: 6, state: 'active', schema: 'redirect', action_payload: 'https://odd.example.net/', filters: [{ name: 'sub_id_1', mode: 'accept', payload: ['x'] }] },
  { name: 'Off', type: 'forced', position: 4, state: 'disabled', schema: 'redirect', action_payload: 'https://example.com/' },
];

test('Keitaro campaign → Umbrella: streams, filters (reject → НЕ), params, cost; landings and unknown filters are reported, not copied', () => {
  const { campaign: c, notes } = mapCampaign(campaign, streams, { 'kt-313': {}, 'kt-314': {} });
  assert.equal(c.id, 'foodiflex-promo', 'alias keeps the /r/<alias> link');
  assert.equal(c.active, false, 'imported campaigns start disabled');
  assert.equal(c.streamRotation, 'position');
  assert.deepEqual(c.paramMap, { external_id: 'fbclid', ad_campaign_id: 'utm_campaign' });
  assert.deepEqual([c.costModel, c.costFromParam], ['cpc', true]);
  assert.equal(c.streams.length, 4, 'unknown-filter and disabled streams are skipped');
  assert.deepEqual(c.streams[0], { name: 'Main', type: 'regular', weight: 100, conditions: { countries: ['FR'], devices: ['mobile'] },
    offers: [{ offerId: 'kt-313', weight: 70 }, { offerId: 'kt-314', weight: 30 }] });
  assert.deepEqual(c.streams[1], { name: 'Fallback', type: 'fallback', conditions: {}, action: 'url', url: 'https://www.sharkninja.fr/?s={click_id}&x=' });
  assert.deepEqual(c.streams[2], { name: 'Not US', type: 'regular', weight: 1, conditions: { countries: ['US'], not: ['countries'] }, offers: [{ offerId: 'kt-313', weight: 100 }] }, 'reject → not');
  assert.deepEqual(c.streams[3].conditions, { referrers: ['facebook.com/ads'], emptyReferrer: false, keywords: ['spam'], ips: ['10.0.0.0/8'], userAgents: ['fban'],
    dateFrom: '2026-11-01', dateTo: '2026-11-30', tz: 'Europe/Paris', not: ['keywords', 'ips'] });
  for (const part of ['лендинг не перенесён', 'выключен', 'домен Keitaro', '{os}', '«sub_id_1» не поддерживается', '1.2.3.1-1.2.3.9']) assert.ok(notes.some((n) => n.includes(part)), `note about ${part}`);
});

test('Keitaro campaign → Umbrella: missing offers are reported and the stream is skipped', () => {
  const { campaign: c, notes } = mapCampaign({ ...campaign, alias: '' }, [streams[1]], { 'kt-313': {} });
  assert.equal(c.id, 'kt-c4982', 'no usable alias → kt-c<id>');
  assert.equal(c.streams.length, 0);
  assert.ok(notes.some((n) => n.includes('kt-314') && n.includes('--ids 314')));
});

test('Keitaro campaign → Umbrella: streams that send bots or ad reviewers elsewhere are not imported (no cloaking)', () => {
  const cloak = (name, filters) => ({ name, type: 'forced', position: 1, state: 'active', schema: 'redirect', action_payload: 'https://white.example.net/', filters });
  const { campaign: c, notes } = mapCampaign(campaign, [
    cloak('UA bots', [{ name: 'user_agent', mode: 'accept', payload: ['facebookexternalhit', 'Googlebot'] }]),
    cloak('Not FB UA', [{ name: 'user_agent', mode: 'reject', payload: ['AdsBot-Google'] }]),
    cloak('Bot IPs', [{ name: 'ip', mode: 'accept', payload: ['10.0.0.0/8'] }]),
  ], {});
  assert.deepEqual(c.streams.map((s) => s.name), ['Bot IPs'], 'only the stream without a bot/reviewer condition is kept');
  assert.equal(notes.filter((n) => n.includes('клоакинг запрещён')).length, 2);
});
