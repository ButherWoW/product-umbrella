// Connection type (Keitaro «Тип соединения»): a heuristic over the visitor's ASN from DB-IP ASN Lite.
// mobile — a mobile-only carrier network; datacenter — hosting/cloud; broadband — everything else.
// Carriers that run fixed and mobile access in one AS (Orange, SFR, Bouygues, Deutsche Telekom…) count as broadband.
export const CONNECTION_TYPES = ['mobile', 'broadband', 'datacenter'];

// ASNs used only for mobile access. Kept explicit because DB-IP names several of them after the parent
// company ("Verizon Business", "AT&T Enterprises"), so the name alone cannot tell them from wireline.
export const MOBILE_ASNS = new Map([
  [21928, 'T-Mobile USA'],
  [6167, 'Verizon Wireless (Cellco Partnership)'],
  [22394, 'Verizon Wireless (Cellco Partnership)'],
  [20057, 'AT&T Mobility'],
  [10507, 'Sprint PCS (now T-Mobile)'],
  [51207, 'Free Mobile (FR)'],
  [25135, 'Vodafone UK mobile'],
  [35228, 'O2 UK (Telefonica UK)'],
  [12576, 'EE (UK)'],
  [206067, 'Three UK (Hutchison 3G)'],
  [45609, 'Bharti Airtel mobile (GPRS)'],
]);

// Organisation names that say the network is mobile: "Free Mobile SAS", "T-Mobile …", "… Wireless", "Hutchison 3G".
const MOBILE_NAME_RE = /\b(mobile|mobility|wireless|cellular|gprs|lte|[345]g)\b/i;

// Pure: { asn, isp, datacenter } from the ASN lookup → 'mobile' | 'datacenter' | 'broadband', or null when unknown.
export function connectionType({ asn = null, isp = null, datacenter = false } = {}) {
  const number = asn === null || asn === undefined || asn === '' ? null : Number(asn);
  if (number === null && !isp) return null;
  if (number !== null && MOBILE_ASNS.has(number)) return 'mobile';
  if (datacenter) return 'datacenter';
  if (isp && MOBILE_NAME_RE.test(isp)) return 'mobile';
  return 'broadband';
}
