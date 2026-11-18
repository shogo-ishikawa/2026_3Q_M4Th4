import assert from 'node:assert/strict';
import test from 'node:test';
import {ticketFactsFor} from '../web/ticket-calendar.js';

test('official date-specific price is only known after capture; university campaign has its own eligible dates', () => {
  const asOf = '2026-12-05T11:00:00Z';
  for (const id of ['land','sea']) {
    const park = {id};
    assert.equal(ticketFactsFor(park,'2026-11-22',asOf).adultOneDayYen,12400);
    assert.deepEqual(ticketFactsFor(park,'2026-11-22','2026-11-10T00:00:00Z'),{});
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

test('selects the latest publicly known price at issue time, even after the source revises it twice', () => {
  const day = '2027-06-01';
  const first = {adultOneDayYen:10000,adultKnownSince:'2027-02-01T00:00:00Z'};
  const park = {id:'land',ticketCalendar:{[day]:{adultOneDayYen:12000,adultKnownSince:'2027-04-01T00:00:00Z',earlierAdultFares:[first,{adultOneDayYen:11000,adultKnownSince:'2027-03-01T00:00:00Z'}]}}};
  assert.equal(ticketFactsFor(park,day,'2027-01-31T23:59:59Z').adultOneDayYen,undefined);
  assert.equal(ticketFactsFor(park,day,'2027-02-01T00:00:00Z').adultOneDayYen,10000);
  assert.equal(ticketFactsFor(park,day,'2027-03-01T00:00:00Z').adultOneDayYen,11000);
  assert.equal(ticketFactsFor(park,day,'2027-04-01T00:00:00Z').adultOneDayYen,12000);
});
