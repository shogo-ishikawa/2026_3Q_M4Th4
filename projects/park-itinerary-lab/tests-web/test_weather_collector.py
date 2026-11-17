"""Forecast publication keeps old source times and bounds repeated provider access."""
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("collect_weather", Path(__file__).resolve().parents[1] / "scripts" / "collect_weather.py")
weather = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(weather)

NOW = dt.datetime(2026, 11, 17, 8, tzinfo=dt.timezone.utc)
OPEN = {"hourly": {"time": ["2026-11-18T09:00"], "temperature_2m": [14], "weather_code": [0], "precipitation": [0], "precipitation_probability": [10]}}
JMA = [{"reportDatetime": "2026-11-17T17:00:00+09:00", "timeSeries": [{"timeDefines": ["2026-11-18T00:00:00+09:00"]}]}]
SERIES = {"reportDateTime": JMA[0]["reportDatetime"], "areaTimeSeries": {"weather": ["晴れ"]}}


def fetch(url):
    return OPEN if url == weather.OPEN_METEO else JMA if url == weather.JMA_FORECAST else SERIES


class WeatherCollectorTests(unittest.TestCase):
    def test_valid_independent_provider_payloads_are_cached(self):
        result = weather.collect(now=NOW, fetch=fetch)
        self.assertEqual(result["refreshAttempt"]["status"], "complete")
        self.assertEqual(result["providers"]["jma"]["forecast"], JMA)
        self.assertEqual(result["providers"]["jma"]["series"], SERIES)
        self.assertEqual(result["providers"]["open-meteo"]["fetchedAt"], "2026-11-17T08:00:00Z")

    def test_hourly_ttl_avoids_contacting_providers_on_each_fifteen_minute_run(self):
        existing = weather.collect(now=NOW, fetch=fetch)

        def must_not_fetch(url):
            self.fail("Fresh forecast should be reused")

        result = weather.collect(existing, now=NOW + dt.timedelta(minutes=59), fetch=must_not_fetch)
        self.assertEqual(result["providers"], existing["providers"])
        self.assertEqual(result["refreshAttempt"]["checkedAt"], "2026-11-17T08:59:00Z")

    def test_failed_refresh_preserves_original_data_and_collection_timestamps(self):
        existing = weather.collect(now=NOW, fetch=fetch)

        def offline(url):
            raise TimeoutError("offline")

        result = weather.collect(existing, now=NOW + dt.timedelta(hours=2), fetch=offline)
        self.assertEqual(result["refreshAttempt"]["status"], "failed")
        self.assertEqual(result["providers"], existing["providers"])
        self.assertEqual(result["providers"]["jma"]["forecast"][0]["reportDatetime"], JMA[0]["reportDatetime"])

    def test_missing_three_hour_product_keeps_daily_jma_forecast(self):
        def without_series(url):
            if url == weather.JMA_SERIES:
                raise TimeoutError("series unavailable")
            return fetch(url)

        result = weather.collect(now=NOW, fetch=without_series)
        self.assertEqual(result["refreshAttempt"]["status"], "partial")
        self.assertIsNone(result["providers"]["jma"]["series"])
        self.assertEqual(result["providers"]["jma"]["forecast"], JMA)

    def test_bad_responses_do_not_overwrite_a_cache_or_create_empty_output(self):
        with self.assertRaisesRegex(ValueError, "No valid forecast"):
            weather.collect(now=NOW, fetch=lambda url: {"invalid": True})
        self.assertFalse(weather.valid_open_meteo({"hourly": {"time": []}}))
        self.assertIsNone(weather.timestamp("2026-11-17T08:00:00"))

    def test_three_hour_values_must_match_the_daily_issue(self):
        def older_series(url):
            if url == weather.JMA_SERIES:
                return {**SERIES, "reportDateTime": "2026-11-17T11:00:00+09:00"}
            return fetch(url)

        result = weather.collect(now=NOW, fetch=older_series)
        self.assertIsNone(result["providers"]["jma"]["series"])
        self.assertIn("jma-series", result["refreshAttempt"]["failedProviders"])


if __name__ == "__main__":
    unittest.main()
