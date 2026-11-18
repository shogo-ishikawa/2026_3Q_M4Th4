import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import archive_daily_weather as weather

DAY = dt.date(2026, 11, 18)
NOW = dt.datetime(2026, 11, 18, 15, tzinfo=dt.timezone.utc)
PARK = {"id": "land", "operatingCalendar": {"2026-11-18": {"windows": [[540, 660]]}}}


def table():
    return """<h3>江戸川臨海（東京都)　2026年11月18日（１時間ごとの値）</h3>
<table id="tablefix1"><tr><th>時</th><th>降水量<br>(mm)</th><th>気温<br>(℃)</th></tr>
<tr><td>9</td><td class="data_0_0">7.0</td><td class="data_0_0">13.1</td></tr>
<tr><td>10</td><td class="data_0_0">0.0</td><td class="data_0_0">14.0</td></tr>
<tr><td>11</td><td class="data_0_0">2.0)</td><td class="data_0_1">15.0</td></tr>
<tr><td>24</td><td class="data_0_0">1.0</td><td class="data_0_0">99.0</td></tr></table>"""


def issued():
    return {"issuedAt": "2026-11-17T21:55:00+09:00", "weatherProvider": "open-meteo",
            "weatherFetchedAt": "2026-11-17T21:45:00+09:00",
            "weatherHours": [{"minute": 540, "endMinute": 600, "weather": "sun", "temperature": 15, "precipitation": 1},
                             {"minute": 600, "endMinute": 660, "temperature": None, "precipitation": 0}]}


class DailyWeatherTest(unittest.TestCase):
    def test_station_table_matches_instant_and_end_label_and_omits_invalid_values(self):
        data = weather.parse_observations(table(), DAY)
        self.assertEqual(data[540], {"temperature": 13.1, "precipitation": 0.0})
        self.assertEqual(data[600], {"temperature": 14.0})
        self.assertNotIn(660, data)
        self.assertEqual(data[1380], {"precipitation": 1.0})
        for html in (table().replace("江戸川臨海", "東京"), table().replace("18日", "17日"),
                     table().replace("降水量<br>(mm)", "風速")):
            with self.assertRaises(ValueError):
                weather.parse_observations(html, DAY)

    def test_only_prospective_pairs_enter_error_for_each_quantity(self):
        observed = weather.parse_observations(table(), DAY)
        issue = issued()
        result = weather.compare(DAY, PARK, issue, observed)
        self.assertEqual(result["metrics"]["temperature"], {"forecastHours": 1, "observedHours": 2, "matchedHours": 1,
                                                         "meanError": 1.9, "mae": 1.9})
        self.assertEqual(result["metrics"]["precipitation"], {"forecastHours": 2, "observedHours": 1, "matchedHours": 1,
                                                            "meanError": 1.0, "mae": 1.0})
        issue["issuedAt"] = "2026-11-18T09:10:00+09:00"
        self.assertEqual(weather.compare(DAY, PARK, issue, observed)["metrics"]["precipitation"]["matchedHours"], 0)
        issue["weatherFetchedAt"] = "2026-11-18T09:15:00+09:00"
        self.assertEqual(weather.compare(DAY, PARK, issue, observed)["forecastHours"], [])
        for old_issue in ({}, {"weatherAssumption": "sun"}):
            metrics = weather.compare(DAY, PARK, old_issue, observed)["metrics"]
            self.assertIsNone(metrics["temperature"]["mae"])
            self.assertEqual(metrics["temperature"]["observedHours"], 2)

    def test_missing_and_partial_data_are_retried_and_a_full_day_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / "forecasts").mkdir()
            forecast = {"date": str(DAY), "parks": [{"parkId": "land", **issued()}]}
            original = json.dumps(forecast)
            (data / "forecasts" / f"{DAY}.json").write_text(original)
            path = data / "weather-daily" / f"{DAY}.json"
            attempt = lambda hour, fetch: weather.archive_day(data, DAY, NOW+dt.timedelta(hours=hour), [PARK], fetch)
            def unavailable(day):
                raise OSError("offline")
            self.assertTrue(attempt(0, unavailable))
            self.assertEqual(json.loads(path.read_text())["status"], "unavailable")
            self.assertFalse(attempt(2, lambda d: self.fail("early retry")))
            self.assertTrue(attempt(3, lambda d: {540: {"temperature": 11.0, "precipitation": 0.0}}))
            self.assertEqual(json.loads(path.read_text())["status"], "partial")
            self.assertTrue(attempt(6, lambda d: {600: {"temperature": 12.0, "precipitation": 0.5}}))
            report = json.loads(path.read_text())
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["parks"][0]["metrics"]["precipitation"]["matchedHours"], 2)
            self.assertFalse(attempt(24, lambda d: self.fail("repeated complete day")))
            self.assertEqual((data / "forecasts" / f"{DAY}.json").read_text(), original)

    def test_closed_day_prevents_collecting_observations_for_an_open_park(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            park = {"id": "sea", "operatingCalendar": {str(DAY): {"windows": [[540, 1380]]}}}
            (data / "catalogue.json").write_text(json.dumps({"parks": [PARK, park]}))
            called = []
            weather.run(data, dt.datetime(2026, 11, 18, 22, tzinfo=weather.JST), lambda d: called.append(d) or {})
            self.assertEqual(called, [DAY-dt.timedelta(days=1)])
