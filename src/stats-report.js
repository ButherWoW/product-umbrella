const GROUPS = ['byCampaign', 'byCountry', 'byOffer', 'byStream', 'byLanding'];

export function metrics(value) {
  const clicks = Number(value.clicks) || 0;
  const conversions = Number(value.conversions) || 0;
  const revenue = Number(value.revenue) || 0;
  const cost = Number(value.cost) || 0;
  const lpClicks = Number(value.lpClicks) || 0;
  const uniqueClicks = Number(value.uniqueClicks ?? value.unique_clicks) || 0;
  return { ...value, clicks, uniqueClicks, conversions, revenue, cost, lpClicks, lpCtr: clicks ? lpClicks / clicks : 0, profit: revenue - cost, cr: clicks ? conversions / clicks : 0,
    epc: clicks ? revenue / clicks : 0, rpm: clicks ? revenue * 1000 / clicks : 0, roi: cost ? (revenue - cost) / cost : 0 };
}

export function emptyReport() {
  return { clicks: 0, conversions: 0, revenue: 0, cost: 0, lpClicks: 0, uniqueClicks: 0, leads: 0, sales: 0, rejected: 0, trash: 0, pendingRevenue: 0,
    ...Object.fromEntries(GROUPS.map((key) => [key, Object.create(null)])) };
}

function add(report, keys, value) {
  const counts = { clicks: Number(value.clicks) || 0, conversions: Number(value.conversions) || 0,
    revenue: Number(value.revenue) || 0, cost: Number(value.cost) || 0, lpClicks: Number(value.lpClicks ?? value.lp_clicks) || 0, uniqueClicks: Number(value.uniqueClicks ?? value.unique_clicks) || 0,
    leads: Number(value.leads) || 0, sales: Number(value.sales) || 0, rejected: Number(value.rejected) || 0, trash: Number(value.trash) || 0,
    pendingRevenue: Number(value.pendingRevenue ?? value.pending_revenue) || 0 };
  for (const field of Object.keys(counts)) report[field] += counts[field];
  GROUPS.forEach((group, index) => {
    const key = keys[index];
    report[group][key] ||= { clicks: 0, conversions: 0, revenue: 0, cost: 0, lpClicks: 0, uniqueClicks: 0, leads: 0, sales: 0, rejected: 0, trash: 0, pendingRevenue: 0 };
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
// A click can have several conversions (main + upsells by tid); each tid counts, the click counts once.
export function reportFromEvents(clicks, conversions) {
  const report = emptyReport();
  // Latest event per (click, tid) wins.
  const latest = new Map();
  for (const item of conversions) latest.set(`${item.clickId}|${item.tid || ''}`, item);
  const byClick = new Map();
  for (const item of latest.values()) { const list = byClick.get(item.clickId); if (list) list.push(item); else byClick.set(item.clickId, [item]); }
  for (const click of clicks) {
    const counts = { clicks: 1, conversions: 0, revenue: Number(click.revenue) || 0, pendingRevenue: 0, cost: click.cost ?? 0, lpClicks: click.lpClicked ? 1 : 0,
      uniqueClicks: click.uniqueCampaign === false ? 0 : 1, leads: 0, sales: 0, rejected: 0, trash: 0 };
    for (const conversion of byClick.get(click.clickId) || []) {
      // Latest status wins; conversions without a status (written before statuses existed) are sales.
      const status = conversion.status || 'sale';
      // A CPC offer's postback amount is not revenue (the payout is booked on the click).
      const amount = conversion.revenueIgnored ? 0 : Number(conversion.revenue) || 0;
      if (status === 'lead' || status === 'sale') counts.conversions += 1;
      if (status === 'sale') { counts.revenue += amount; counts.sales += 1; }
      if (status === 'lead') { counts.pendingRevenue += amount; counts.leads += 1; }
      if (status === 'rejected') counts.rejected += 1;
      if (status === 'trash') counts.trash += 1;
    }
    add(report, [click.campaign, click.country || 'unknown', click.offerId || 'unknown',
      click.stream || 'default', click.landingId || 'none'], counts);
  }
  return finish(report);
}
