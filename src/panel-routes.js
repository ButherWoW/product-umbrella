// Panel pages with path URLs (/campaigns, /campaigns/<id>, /reports?group=…). The server answers each of them
// with the same shell (public/admin/index.html); public/admin/admin.js renders the section from location.pathname.
// Tracking domains never serve these paths (see isTrackingPath in server.js).
export const PANEL_SECTIONS = ['dashboard', 'campaigns', 'offers', 'landings', 'sources', 'networks', 'trends',
  'reports', 'clicks', 'conversions', 'botlog', 'buyers', 'users', 'keys'];

const SECTION_RE = new RegExp(`^/(?:login|${PANEL_SECTIONS.join('|')})/?$`);
// One campaign: /campaigns/<id> and /campaigns/new. The id is URL-encoded by the panel, so it never contains '/'.
const CAMPAIGN_RE = /^\/campaigns\/[^/]{1,200}\/?$/;

export const isPanelPath = (p) => p === '/' || SECTION_RE.test(p) || CAMPAIGN_RE.test(p);
