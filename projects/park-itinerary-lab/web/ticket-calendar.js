import {archivedFares, archivedFaresKnownBy, archivedFareSource, seedFares, faresCheckedAt} from './ticket-calendar-seed.js?v=2.2.0';

const parks = {land:'tdl', sea:'tds'};
const campus = {
  announcedAt:'2026-11-04T11:23:00+09:00', coverageFrom:'2026-11-04', coverageThrough:'2027-03-23',
  first:'2027-01-04', last:'2027-03-19', discount:1000,
  url:'https://www.tokyodisneyresort.jp/treasure/spring2027/'
};
const price = x => Number.isInteger(x) && x >= 1000 && x <= 99999;
const available = (stamp, cutoff) => typeof stamp === 'string' &&
  /(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) && Date.parse(stamp) <= cutoff;

/** Reconstruct the advertised adult fare and the tracked university-student offer as known at the cutoff. */
export function ticketFactsFor(park, date, asOf = Date.now()) {
  const cutoff = typeof asOf === 'number' ? asOf : Date.parse(asOf);
  if (!Object.hasOwn(parks, park?.id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(cutoff)) return {};
  const entry = park.ticketCalendar?.[date] || {};
  const rows = Array.isArray(entry.earlierAdultFares) ? [...entry.earlierAdultFares, entry] : [entry];
  const archived = archivedFares.get(date);
  if (archived !== undefined) rows.push({adultOneDayYen:archived, adultKnownSince:archivedFaresKnownBy,
    sourceUrl:archivedFareSource});
  const seed = seedFares.get(date)?.[park.id === 'land' ? 0 : 1];
  if (price(seed)) rows.unshift({adultOneDayYen:seed, adultKnownSince:faresCheckedAt,
    sourceUrl:`https://www.tokyodisneyresort.jp/${parks[park.id]}/monthly/calendar/${date.slice(0,7).replace('-','')}/`});
  const adult = rows.filter(row => price(row?.adultOneDayYen) && available(row.adultKnownSince ?? row.knownSince, cutoff))
    .sort((a,b) => Date.parse(b.adultKnownSince ?? b.knownSince) - Date.parse(a.adultKnownSince ?? a.knownSince))[0];
  const result = adult ? {adultOneDayYen:adult.adultOneDayYen, adultKnownSince:adult.adultKnownSince ?? adult.knownSince, sourceUrl:adult.sourceUrl} : {};
  const monitored = date >= campus.coverageFrom && date <= campus.coverageThrough && available(campus.announcedAt, cutoff);
  if (monitored) {
    result.studentOffer = date >= campus.first && date <= campus.last;
    result.studentKnownSince = campus.announcedAt;
    result.studentSourceUrl = campus.url;
    if (result.studentOffer && adult) {
      result.studentOneDayYen = adult.adultOneDayYen - campus.discount;
      result.studentPriceKnownSince = Date.parse(result.adultKnownSince) > Date.parse(campus.announcedAt) ? result.adultKnownSince : campus.announcedAt;
    }
  }
  const announced = entry.studentKnownSince ?? entry.knownSince;
  if (typeof entry.studentOffer === 'boolean' && available(announced,cutoff) &&
      (!monitored || Date.parse(announced) >= Date.parse(campus.announcedAt))) {
    result.studentOffer = entry.studentOffer;
    result.studentKnownSince = announced;
    result.studentSourceUrl = entry.studentSourceUrl ?? entry.sourceUrl;
    delete result.studentOneDayYen;
    delete result.studentPriceKnownSince;
  }
  const studentPriceSince = entry.studentPriceKnownSince ?? announced;
  if (result.studentOffer && price(entry.studentOneDayYen) && available(studentPriceSince,cutoff) &&
      (!result.studentPriceKnownSince || Date.parse(studentPriceSince) >= Date.parse(result.studentPriceKnownSince))) {
    result.studentOneDayYen = entry.studentOneDayYen;
    result.studentPriceKnownSince = studentPriceSince;
  }
  return result;
}
