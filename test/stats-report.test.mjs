import assert from 'node:assert/strict';
import test from 'node:test';
import { reportFromEvents, reportFromRows } from '../src/stats-report.js';

const clicks = [
  { clickId: 'a', campaign: 'alpha', country: 'US', offerId: 'offer-a', stream: 'ios' },
  { clickId: 'b', campaign: 'alpha', country: 'US', offerId: 'offer-b', stream: 'ios' },
  { clickId: 'c', campaign: 'beta', country: null, offerId: 'offer-a', stream: null },
];
const conversions = [{ clickId: 'a', revenue: '4.25' }, { clickId: 'c', revenue: 1.75 }];

test('all report dimensions preserve conversions and revenue', () => {
  const report = reportFromEvents(clicks, conversions);
  assert.equal(report.clicks, 3);
  assert.equal(report.conversions, 2);
  assert.equal(report.revenue, 6);
  for (const group of ['byCampaign', 'byCountry', 'byOffer', 'byStream', 'byLanding']) {
    const items = Object.values(report[group]);
    assert.equal(items.reduce((sum, value) => sum + value.clicks, 0), report.clicks);
    assert.equal(items.reduce((sum, value) => sum + value.conversions, 0), report.conversions);
    assert.equal(items.reduce((sum, value) => sum + value.revenue, 0), report.revenue);
  }
  assert.equal(report.byStream.default.revenue, 1.75);
  assert.equal(report.byStream.ios.epc, 4.25 / 2);
  assert.equal(report.byStream.ios.cr, 0.5);
});

test('PostgreSQL aggregates produce the same report as JSONL events', () => {
  const rows = [
    { campaign: 'alpha', country: 'US', offer_id: 'offer-a', stream: 'ios', clicks: 1, conversions: 1, revenue: '4.25' },
    { campaign: 'alpha', country: 'US', offer_id: 'offer-b', stream: 'ios', clicks: 1, conversions: 0, revenue: 0 },
    { campaign: 'beta', country: null, offer_id: 'offer-a', stream: null, clicks: 1, conversions: 1, revenue: '1.75' },
  ];
  assert.deepEqual(reportFromRows(rows), reportFromEvents(clicks, conversions));
});

test('empty reports always expose metrics and all dimensions', () => {
  const report = reportFromEvents([], []);
  assert.deepEqual(report, { clicks: 0, conversions: 0, revenue: 0, cost: 0, lpClicks: 0, lpCtr: 0, profit: 0, cr: 0, epc: 0, rpm: 0, roi: 0,
    byCampaign: {}, byCountry: {}, byOffer: {}, byStream: {}, byLanding: {} });
});

test('user-supplied stream names cannot collide with object prototypes', () => {
  const report = reportFromEvents([{ ...clicks[0], campaign: 'constructor', stream: '__proto__' }], conversions);
  assert.equal(report.byCampaign.constructor.clicks, 1);
  assert.equal(report.byStream.__proto__.revenue, 4.25);
  assert.equal({}.clicks, undefined);
});

test('cost, profit and ROI aggregate per dimension and match between JSONL and PostgreSQL', () => {
  const costed = clicks.map((click, i) => ({ ...click, cost: [0.5, 0.5, 0.25][i] }));
  const report = reportFromEvents(costed, conversions);
  assert.equal(report.cost, 1.25);
  assert.equal(report.profit, 6 - 1.25);
  assert.equal(report.roi, (6 - 1.25) / 1.25);
  assert.equal(report.byCampaign.alpha.cost, 1);
  assert.equal(report.byCampaign.alpha.profit, 3.25);
  assert.equal(reportFromEvents(clicks, []).roi, 0, 'no cost means ROI 0, not Infinity');
  const rows = [
    { campaign: 'alpha', country: 'US', offer_id: 'offer-a', stream: 'ios', clicks: 1, conversions: 1, revenue: '4.25', cost: '0.5' },
    { campaign: 'alpha', country: 'US', offer_id: 'offer-b', stream: 'ios', clicks: 1, conversions: 0, revenue: 0, cost: 0.5 },
    { campaign: 'beta', country: null, offer_id: 'offer-a', stream: null, clicks: 1, conversions: 1, revenue: '1.75', cost: 0.25 },
  ];
  assert.deepEqual(reportFromRows(rows), report);
});
