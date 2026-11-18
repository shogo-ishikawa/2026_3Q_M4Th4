import assert from 'node:assert/strict';
import test from 'node:test';
import {ticketFactsFor} from '../web/ticket-calendar.js';
import {visitDayContext} from '../web/calendar-features.js';

test('official date-specific price is only known after capture; university campaign has its own eligible dates', () => {
  const asOf = '2026-12-05T11:00:00Z';
  for (const id of ['land','sea']) {
    const park = {id};
    assert.equal(ticketFactsFor(park,'2026-11-22',asOf).adultOneDayYen,12400);
    assert.deepEqual(ticketFactsFor(park,'2026-11-22','2026-11-03T10:00:00Z'),{});
    assert.equal(ticketFactsFor(park,'2027-01-03',asOf).studentOffer,false);
    const first = ticketFactsFor(park,'2027-01-04',asOf);
    assert.equal(first.studentOffer,true);
    assert.equal(first.adultOneDayYen-first.studentOneDayYen,1000);
    assert.equal(ticketFactsFor(park,'2027-03-19',asOf).studentOffer,true);
    assert.equal(ticketFactsFor(park,'2027-03-20',asOf).studentOffer,false);
    assert.equal(ticketFactsFor(park,'2027-03-24',asOf).studentOffer,undefined);
    assert.deepEqual(ticketFactsFor(park,'2028-08-01',asOf),{});
  }
});

test('rebuilds historical visit inputs from a dated price record and an independently timed campaign announcement', () => {
  for (const park of [{id:'land'}, {id:'sea'}]) {
    assert.equal(visitDayContext('2026-11-03',park).adult_ticket_yen,undefined);
    assert.equal(visitDayContext('2026-11-04',park).adult_ticket_yen,9900);
    assert.equal(visitDayContext('2026-11-04',park).student_offer,undefined);
    for (const [date, price] of [['2026-11-13',10900],['2026-11-14',12400],['2026-11-15',11900]]) {
      assert.deepEqual(visitDayContext(date,park),{adult_ticket_yen:price,student_offer:0});
    }
    assert.equal(ticketFactsFor(park,'2027-01-04','2026-11-04T11:22:59+09:00').studentOffer,undefined);
    const announced = ticketFactsFor(park,'2027-01-04','2026-11-04T11:23:00+09:00');
    assert.equal(announced.studentOffer,true);
    assert.equal(announced.studentOneDayYen,undefined);
    const prior = ticketFactsFor(park,'2026-11-22','2026-11-10T00:00:00Z');
    assert.equal(prior.sourceUrl,'https://www.pricey.jp/web/articles/7323');
    const latest = ticketFactsFor(park,'2026-11-22','2026-11-19T12:00:00+09:00');
    assert.match(latest.sourceUrl,/^https:\/\/www\.tokyodisneyresort\.jp\//);
  }
});

test('selects the latest publicly known price at issue time, even after the source revises it twice', () => {
  const day = '2027-06-01';
  const first = {adultOneDayYen:10000,adultKnownSince:'2027-02-01T00:00:00Z'};
  const park = {id:'land',ticketCalendar:{[day]:{adultOneDayYen:12000,adultKnownSince:'2027-04-01T00:00:00Z',earlierAdultFares:[first,{adultOneDayYen:11000,adultKnownSince:'2027-03-01T00:00:00Z'}]}}};
  assert.equal(ticketFactsFor(park,day,'2027-01-31T23:59:59Z').adultOneDayYen,undefined);
  assert.equal(ticketFactsFor(park,day,'2027-02-01T00:00:00Z').adultOneDayYen,10000);
  assert.equal(ticketFactsFor(park,day,'2027-03-01T00:00:00Z').adultOneDayYen,11000);
  assert.equal(ticketFactsFor(park,day,'2027-04-01T00:00:00Z').adultOneDayYen,12000);
});
