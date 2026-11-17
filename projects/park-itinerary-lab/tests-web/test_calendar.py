import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'scripts/update_calendar.py'
spec = importlib.util.spec_from_file_location('park_calendar', path)
calendar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calendar)

class CalendarTests(unittest.TestCase):
    def test_real_calendar_includes_substitute_and_citizens_holidays(self):
        import json
        data = json.loads((path.parents[1] / 'web/data/calendar.json').read_text())
        by_date = {row['date']:row['name'] for row in data['holidays']}
        self.assertIn('2026-09-22',by_date)
        self.assertIn('2026-05-06',by_date)
        self.assertIn('2027-03-22',by_date)
        self.assertEqual(data['coverage']['endDate'],'2027-12-31')
    def test_cp932_and_utf8_bom_csv(self):
        text='国民の祝日・休日月日,国民の祝日・休日名称\n2026/1/1,元日\n2026/5/6,休日\n'
        for encoding in ['cp932','utf-8-sig']:
            rows=calendar.parse_holidays(text.encode(encoding))
            self.assertEqual(rows[1],{'date':'2026-05-06','name':'休日'})
    def test_invalid_response_does_not_become_empty_holiday_calendar(self):
        with self.assertRaises(ValueError):calendar.calendar_document(b'<html>Temporarily unavailable</html>')

if __name__ == '__main__':unittest.main()
