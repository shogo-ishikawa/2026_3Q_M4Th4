import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from update_park_data import parse_opening_calendar, record_calendar


class OfficialFares(unittest.TestCase):
    def test_exact_park_price_is_distinct_from_availability_and_other_numbers(self):
        example = '<a href="/tdl/daily/calendar/20261211/"><p class="openTime">9:00-21:00</p><span class="remaining">販売中</span><span class="ticketStatus">{}</span></a>'
        self.assertEqual(parse_opening_calendar(example.format('￥10,900'),'land')['2026-12-11']['adultOneDayYen'],10900)
        for text in ('販売なし','￥8,000～￥10,000',''):
            self.assertNotIn('adultOneDayYen', parse_opening_calendar(example.format(text),'land')['2026-12-11'])
        self.assertEqual(parse_opening_calendar(example.format('￥10,900'),'sea'),{})

    def test_refresh_retains_first_verification_and_preserves_every_revision(self):
        park = {}
        def update(day, price, when):
            row = {'windows':[[540,1260]], 'sourceUrl':'https://www.tokyodisneyresort.jp/tdl/daily/calendar/20261211/'}
            if price is not None:
                row['adultOneDayYen'] = price
            record_calendar(park,{day:row},when)
        day = '2026-12-11'
        first, second = '2026-11-19T06:00:00Z','2026-11-20T06:00:00Z'
        update(day,10900,first)
        update(day,10900,second)
        update(day,None,second)
        self.assertEqual(park['ticketCalendar'][day]['adultKnownSince'],first)
        update(day,11400,second)
        self.assertEqual(park['ticketCalendar'][day]['earlierAdultFares'][0]['adultOneDayYen'],10900)
        update(day,12400,'2026-12-12T06:00:00Z')
        self.assertEqual(park['ticketCalendar'][day]['adultOneDayYen'],11400)
        self.assertNotIn('adultOneDayYen',park['operatingCalendar'][day])
