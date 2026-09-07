/**
 * The simulated commercial layer's one piece of shared logic: turning a listing
 * into a candidate site.
 *
 * It lives here rather than inside scripts/query-listings.mjs so a test can hold
 * it to the contract that matters — adopting a listing must answer every
 * FIELD_CHECKS question. That contract broke silently once already: `hasGas` was
 * editable in the UI and persisted by the server, but no listing carried it and
 * no field check asked for it, so it was a field nothing could ever fill.
 */
import { randomUUID } from 'node:crypto'

/** Fields a listing supplies, keyed by the site field they answer. */
export const LISTING_TO_SITE = {
  area: 'areaSqm',
  rent: 'rentPerMonth',
  transferFee: 'transferFee',
  frontage: 'frontageM',      // null for mall units — a mall shop has no frontage
  floor: 'floor',
  ceilingM: 'ceilingM',
  powerKw: 'powerKw',
  hasFlue: 'hasFlue',
  hasWater: 'hasWater',
  canLicense: 'canLicense',
  hasGas: 'hasGas',
}

export function siteFromListing(listing, at = new Date().toISOString(), parentId = '') {
  const site = {
    id: `site-${randomUUID().slice(0, 8)}`,
    // A listing is a unit inside a location, not a peer of one.
    kind: 'unit',
    parentId,
    name: `${listing.address}（${listing.areaSqm}㎡）`,
    address: listing.address,
    lng: listing.lng, lat: listing.lat,
    landlord: listing.agent,
    source: `铺源 ${listing.id}　${listing.channel}`,
    status: 'tovisit',
    fieldNotes: [{
      id: randomUUID(), at, author: 'DSH（模拟铺源）',
      observation: `前身 ${listing.formerUse}，已空置 ${listing.vacantMonths} 个月，`
        + `免租 ${listing.freeRentDays} 天，租期 ${listing.leaseYears} 年年递增 ${listing.increaseRatePct}%，`
        + `物业费 ${listing.propertyFeePerSqm} 元/㎡/月，`
        + `${listing.hasGas ? '有' : '无'}市政燃气。签约前需现场核实。`,
    }],
    decision: null, createdAt: at, updatedAt: at,
  }
  for (const [siteKey, listingKey] of Object.entries(LISTING_TO_SITE)) {
    site[siteKey] = listing[listingKey] ?? null
  }
  return site
}
