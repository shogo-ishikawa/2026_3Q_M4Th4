import {activityAvailable} from './operation-windows.js';

export const WISH_PRESETS = [
  {id:'classics', label:'王道アトラクション'},
  {id:'thrills', label:'スリルを楽しむ'},
  {id:'stage', label:'ショー＆グルメ'},
];

// Each group takes up to the given number of available facilities, in order.
// Use stable catalogue IDs so a similarly named shop cannot replace a ride.
const groups = {
  land:{
    classics:[
      [4, 'attraction-197', 'attraction-174', 'attraction-160', 'attraction-152', 'attraction-172'],
      [1, 'restaurant-338', 'restaurant-332', 'restaurant-357'],
      [1, 'popcorn-292', 'snack-350', 'snack-331'],
      [1, 'shop-513', 'shop-500'],
    ],
    thrills:[
      [4, 'attraction-160', 'attraction-162', 'attraction-183', 'attraction-179', 'attraction-196'],
      [1, 'restaurant-344', 'restaurant-339', 'restaurant-338'],
    ],
    stage:[
      [2, 'parade-7000', 'parade-913', 'parade-7003', 'show-951'],
      [1, 'restaurant-349', 'restaurant-335'],
      [1, 'attraction-167', 'attraction-158'],
      [1, 'cafe-304', 'cafe-316'],
    ],
  },
  sea:{
    classics:[
      [4, 'attraction-255', 'attraction-219', 'attraction-218', 'attraction-223', 'attraction-256'],
      [1, 'restaurant-418', 'restaurant-459', 'restaurant-463'],
      [1, 'snack-450', 'snack-419'],
      [1, 'shop-601', 'shop-621'],
    ],
    thrills:[
      [4, 'attraction-243', 'attraction-242', 'attraction-223', 'attraction-257', 'attraction-237'],
      [1, 'restaurant-459', 'restaurant-418'],
    ],
    stage:[
      [2, 'show-967', 'show-7404', 'show-953', 'show-952'],
      [1, 'restaurant-403', 'restaurant-400'],
      [1, 'attraction-230', 'attraction-235'],
      [1, 'cafe-401', 'snack-450'],
    ],
  },
};

export function presetFacilities(park, settings, presetId) {
  const catalogue = new Map(park.activities.map(a => [a.id, a]));
  const progress = settings.dayProgress;
  const records = progress?.parkId === park.id && progress.date === settings.date ? progress.visits : {};
  return (groups[park.id]?.[presetId] || []).flatMap(([limit, ...ids]) => {
    const candidates = ids.map(id => catalogue.get(park.id + '-' + id)).filter(a =>
      a && (!a.access || a.access === 'normal') && activityAvailable(a, settings.date) &&
      (!records?.[a.id] || records[a.id].status === 'pending'));
    return candidates.slice(0, limit);
  });
}

export function presetStartsPlan(state) {
  const {settings} = state;
  return !state.result && !settings.selections.length && settings.replanFrom == null &&
    !Object.keys(settings.dayProgress?.visits || {}).length &&
    !settings.purchases?.length && !settings.fixedBreaks?.length;
}

export function addPresetWishes(settings, facilities, makeWish) {
  const existing = new Set(settings.selections.map(wish => wish.id));
  const additions = facilities.filter(a => !existing.has(a.id)).map(makeWish);
  settings.selections.push(...additions);
  return additions.length;
}
