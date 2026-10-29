import { createHash } from 'node:crypto';

// Keitaro «Привязка посетителей»: a returning visitor (same IP + User-Agent, like the uniqueness check)
// gets the stream — and for 'stream_offer' the offer and landing — they got last time, within the campaign's TTL.
// In-memory LRU, bounded like the uniqueness cache: bindings reset on restart (the next visit simply rebinds).
export const BIND_MODES = ['off', 'stream', 'stream_offer'];

export function parseBindMode(value) { return BIND_MODES.includes(value) ? value : 'off'; }
export function parseBindTtl(value) { return Number.isInteger(value) && value >= 1 && value <= 720 ? value : 24; }

export function bindingKey(campaignId, ip, userAgent) {
  return createHash('sha1').update(`b|${campaignId}|${ip || ''}|${userAgent || ''}`).digest('base64');
}

// Streams have no stable id: a binding remembers the position and name and only counts while both still agree.
export function streamRef(streams, stream) {
  const index = streams.indexOf(stream);
  return index < 0 ? null : { index, name: stream.name ?? null };
}
export function resolveStreamRef(streams, ref) {
  const stream = ref ? streams?.[ref.index] : null;
  return stream && (stream.name ?? null) === ref.name ? stream : null;
}

export function createBindingStore({ limit = 300000 } = {}) {
  const items = new Map();
  return {
    // The binding, if it is younger than ttlMs (counted from the last visit). Read-only: simulation uses it too.
    get(key, ttlMs, now = Date.now()) {
      const item = items.get(key);
      return item && now - item.at < ttlMs ? item : null;
    },
    set(key, value, now = Date.now()) {
      items.delete(key);
      items.set(key, { ...value, at: now });
      if (items.size > limit) items.delete(items.keys().next().value);
    },
    get size() { return items.size; },
  };
}

// The bound choice if it is still valid for this visitor, else null (then: normal selection + rebinding).
// Valid: the stream still exists, is enabled, matches the visitor and has a usable offer; for 'stream_offer'
// the bound offer itself must still be in the stream and not excluded (capped/archived), and the bound landing kept.
export function boundChoice({ mode, binding, streams, matches, excluded = new Set(), pickOffer, pickLanding }) {
  if (mode === 'off' || !binding) return null;
  const stream = resolveStreamRef(streams, binding.stream);
  if (!stream || stream.enabled === false || !matches(stream)) return null;
  if (stream.action) return { stream, offerId: null };
  const live = stream.offers ? stream.offers.filter((o) => !excluded.has(o.offerId)) : (excluded.has(stream.offerId) ? [] : [stream]);
  if (!live.length) return null;
  if (mode === 'stream') return { stream, offerId: stream.offers ? pickOffer(live).offerId : stream.offerId, landingId: stream.landings?.length ? pickLanding(stream.landings).landingId : null };
  if (!live.some((o) => o.offerId === binding.offerId)) return null;
  const landingId = stream.landings?.some((l) => l.landingId === binding.landingId) ? binding.landingId
    : stream.landings?.length ? pickLanding(stream.landings).landingId : null;
  return { stream, offerId: binding.offerId, landingId };
}
