// Fills an empty tracker with demo offers, campaigns, clicks and conversions so /admin has something to show.
// Usage on the server: node deploy/seed-demo.mjs http://127.0.0.1:4110  (reads ADMIN_TOKEN and POSTBACK_SECRET from env)
const base = process.argv[2] || 'http://127.0.0.1:4110';
const token = process.env.ADMIN_TOKEN || '';
const secret = process.env.POSTBACK_SECRET || '';
const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const send = async (path, body, method = 'POST') => {
  const res = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const existing = await (await fetch(base + '/api/campaigns')).json();
if (Object.keys(existing.campaigns || {}).some((id) => id.startsWith('demo-'))) {
  console.log('demo data already present, skipping');
  process.exit(0);
}

await send('/api/offers', { id: 'demo-offer-a', url: 'https://example.com/a?cid={click_id}&s1={sub_id_1}' });
await send('/api/offers', { id: 'demo-offer-b', url: 'https://example.org/b?cid={click_id}', dailyCap: 5000 });
await send('/api/campaigns', { id: 'demo-fr', name: '[Demo] FR — кухонная техника', costModel: 'cpc', cpc: 0.12, costFromParam: true,
  paramMap: { sub_id_1: 'ad_id' }, streams: [
    { name: 'iOS', type: 'forced', conditions: { os: ['ios'] }, offers: [{ offerId: 'demo-offer-a', weight: 1 }] },
    { name: 'Main', offers: [{ offerId: 'demo-offer-a', weight: 70 }, { offerId: 'demo-offer-b', weight: 30 }], weight: 1 },
    { name: 'Rest', type: 'fallback', offers: [{ offerId: 'demo-offer-b', weight: 1 }] },
  ] });
await send('/api/campaigns', { id: 'demo-de', name: '[Demo] DE — гаджеты', dailyCap: 2000, costModel: 'cpc', cpc: 0.08,
  streams: [{ name: 'Main', offers: [{ offerId: 'demo-offer-b', weight: 1 }] }] });

const uas = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
];
let clicks = 0; let conversions = 0;
for (let i = 0; i < 120; i++) {
  const campaign = i % 3 === 0 ? 'demo-de' : 'demo-fr';
  const res = await fetch(`${base}/r/${campaign}?ad_id=ad${i % 4}&bid=0.${10 + (i % 7)}&subid=demo${i % 5}`,
    { redirect: 'manual', headers: { 'user-agent': uas[i % 3], 'x-forwarded-for': `198.51.100.${1 + (i % 200)}`, referer: 'https://facebook.com/' } });
  const cid = new URL(res.headers.get('location')).searchParams.get('cid') || new URL(res.headers.get('location')).searchParams.get('click_id');
  clicks += 1;
  if (cid && i % 9 === 0 && secret) {
    await fetch(`${base}/postback?click_id=${cid}&secret=${encodeURIComponent(secret)}&revenue=19.99&currency=EUR`);
    conversions += 1;
  }
}
console.log(`demo data seeded: ${clicks} clicks, ${conversions} conversions`);
