import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('park_catalogue_updater', Path(__file__).resolve().parents[1] / 'scripts/update_park_data.py')
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)


class CatalogueUpdateTests(unittest.TestCase):
    def test_date_specific_times_and_changes_preserve_positions(self):
        html = '''<ul><li data-categorize="ride"><a href="/tdl/attraction/detail/1/"><h3 class="heading3">Example NEW</h3><p class="area">Area</p><div class="date-20261117">9:00 - 18:00 運営/公演予定</div><div class="date-20261118">10:00 - 20:00</div><div>ディズニー・プレミアアクセス対象</div></a></li></ul>'''
        records = UPDATER.parse_list(html, '2026-11-17', 'land')
        self.assertEqual(records[0]['times'], [540, 1080])
        original = {'parks': [{'id': 'land', 'activities': [{'id': 'ride', 'name': 'Old', 'area': 'Old area', 'node': 'fixed-position', 'category': 'attraction', 'sourceUrl': 'https://www.tokyodisneyresort.jp/tdl/attraction/detail/1/', 'windows': [[600, 1200]], 'closedDates': ['2026-11-17']}]}]}
        result, report = UPDATER.refresh_catalogue(original, records, '2026-11-17')
        ride = result['parks'][0]['activities'][0]
        self.assertEqual(ride['node'], 'fixed-position')
        self.assertEqual(ride['windows'], [[540, 1080]])
        self.assertEqual(ride['closedDates'], [])
        self.assertEqual(ride['name'], 'Example')
        self.assertEqual(original['parks'][0]['activities'][0]['name'], 'Old')
        self.assertEqual(len(report['dpaReview']), 1)

    def test_closed_day_and_missing_date_are_distinguished(self):
        html = '''<li data-categorize="show"><a href="/tds/show/detail/2/"><h3 class="heading3">Show</h3><div class="date-20261117">ー 運営/公演予定</div></a></li>'''
        self.assertTrue(UPDATER.parse_list(html, '2026-11-17', 'sea')[0]['hasDailySchedule'])
        self.assertFalse(UPDATER.parse_list(html, '2027-01-01', 'sea')[0]['hasDailySchedule'])
        original = {'parks': [{'id': 'sea', 'activities': [{'id': 'show', 'name': 'Show', 'category': 'show', 'sourceUrl': 'https://www.tokyodisneyresort.jp/tds/show/detail/2/', 'showTimes': [720, 900], 'showTimesDate': '2026-11-16'}]}]}
        result, _ = UPDATER.refresh_catalogue(original, UPDATER.parse_list(html, '2026-11-17', 'sea'), '2026-11-17')
        self.assertEqual(result['parks'][0]['activities'][0]['closedDates'], ['2026-11-17'])
        future, _ = UPDATER.refresh_catalogue(original, UPDATER.parse_list(html, '2027-01-01', 'sea'), '2027-01-01')
        self.assertEqual(future['parks'][0]['activities'][0]['showTimesDate'], '2026-11-16')
        self.assertNotIn('closedDates', future['parks'][0]['activities'][0])

    def test_show_times_are_unique_and_new_facilities_are_reported(self):
        html = '''<li data-categorize="show"><a href="/tdl/show/detail/3/"><h3 class="heading3">New show</h3><div class="date-20261117"><span>11:00 / 13:20 / 15:00</span><span>11:00 / 13:20 / 15:00</span></div></a></li>'''
        records = UPDATER.parse_list(html, '2026-11-17', 'land')
        self.assertEqual(records[0]['times'], [660, 800, 900])
        self.assertFalse(records[0]['isRange'])
        _, report = UPDATER.refresh_catalogue({'parks': [{'id': 'land', 'activities': []}]}, records, '2026-11-17')
        self.assertEqual(len(report['newFacilities']), 1)


if __name__ == '__main__':
    unittest.main()
