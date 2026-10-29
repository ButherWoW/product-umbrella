const GROUPS = ['byCampaign', 'byCountry', 'byOffer', 'byStream', 'byLanding'];

export function metrics(value) {
  const clicks = Number(value.clicks) || 0;
  const conversions = Number(value.conversions) || 0;
  const revenue = Number(value.revenue) || 0;
  const cost = Number(value.cost) || 0;
  const lpClicks = Number(value.lpClicks) || 0;
  return { ...value, clicks, conversions, revenue, cost, lpClicks, lpCtr: clicks ? lpClicks / clicks : 0, profit: revenue - cost, cr: clicks ? conversions / clicks : 0,
    epc: clicks ? revenue / clicks : 0, rpm: clicks ? revenue * 1000 / clicks : 0, roi: cost ? (revenue - cost) / cost : 0 };
}

export function emptyReport() {
  return { clicks: 0, conversions: 0, revenue: 0, cost: 0, lpClicks: 0,
    ...Object.fromEntries(GROUPS.map((key) => [key, Object.create(null)])) };
}

function add(report, keys, value) {
  const counts = { clicks: Number(value.clicks) || 0, conversions: Number(value.conversions) || 0,
    revenue: Number(value.revenue) || 0, cost: Number(value.cost) || 0, lpClicks: Number(value.lpClicks ?? value.lp_clicks) || 0 };
  for (const field of Object.keys(counts)) report[field] += counts[field];
  GROUPS.forEach((group, index) => {
    const key = keys[index];
    report[group][key] ||= { clicks: 0, conversions: 0, revenue: 0, cost: 0, lpClicks: 0 };
    for (const field of Object.keys(counts)) report[group][key][field] += counts[field];
  });
}

function finish(report) {
  return { ...metrics(report), ...Object.fromEntries(GROUPS.map((group) => [group,
    Object.fromEntries(Object.entries(report[group]).map(([key, value]) => [key, metrics(value)]))])) };
}

export function reportFromRows(rows) {
  const report = emptyReport();
  for (const row of rows) add(report, [row.campaign, row.country || 'unknown',
    row.offer_id || 'unknown', row.stream || 'default', row.landing_id || 'none'], row);
  return finish(report);
}

// Every dimension uses the originating click, including conversions arriving later.
export function reportFromEvents(clicks, conversions) {
  const report = emptyReport();
  const revenueByClick = new Map(conversions.map((item) => [item.clickId, item]));
  for (const click of clicks) {
    const conversion = revenueByClick.get(click.clickId);
    add(report, [click.campaign, click.country || 'unknown', click.offerId || 'unknown',
      click.stream || 'default', click.landingId || 'none'], { clicks: 1, conversions: conversion ? 1 : 0,
      revenue: conversion?.revenue ?? 0, cost: click.cost ?? 0, lpClicks: click.lpClicked ? 1 : 0 });
  }
  return finish(report);
}
