"""提供ZIPの日本語パスと、保存PSDの再現性を確認します。"""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
sys.path.insert(0, str(PROJECT / "tests"))
from test_reanalysis import saved_result

spec = importlib.util.spec_from_file_location("import_reference_results", PROJECT / "scripts/import_reference_results.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ReferenceImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = saved_result()

    def test_full_spectrum_corruption_is_rejected_even_when_saved_fit_is_unchanged(self):
        importer.verify_spectrum(self.original)
        changed = deepcopy(self.original)
        changed["spectrum"]["power"][10] *= 2
        with self.assertRaisesRegex(ValueError, "PSD"):
            importer.verify_spectrum(changed)

    def test_mac_encoded_and_decomposed_japanese_names_have_one_lookup_spelling(self):
        expected = "DB/スピッツ_春の歌/result.json"
        decomposed = "DB/スピッツ_春の歌/result.json"
        mojibake = decomposed.encode("utf-8").decode("cp437")
        self.assertEqual(importer.normalised_member(expected), expected)
        self.assertEqual(importer.normalised_member(decomposed), expected)
        self.assertEqual(importer.normalised_member(mojibake), expected)

    def test_archive_import_resolves_unicode_and_rejects_ambiguous_members(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            archive_path, catalogue = folder / "input.zip", folder / "catalogue.json"
            decomposed = "DB/スピッツ_春の歌/result.json"
            member = "DB/スピッツ_春の歌/result.json"
            catalogue.write_text(json.dumps({
                "schema_version": "vocal-reference-import-catalogue-v1", "provided_at": "2026-11-11",
                "entries": [{"member": member, "artist": "歌手", "track": "曲", "include_in_comparison": True}],
            }))
            with ZipFile(archive_path, "w") as archive:
                archive.writestr(decomposed, json.dumps(self.original))
            manifest = importer.import_archive(archive_path, catalogue, folder / "output")
            self.assertEqual(len(manifest["records"]), 1)
            self.assertTrue(manifest["records"][0]["original_spectrum_verified"])
            with ZipFile(archive_path, "a") as archive:
                archive.writestr(member, json.dumps(self.original))
            with self.assertRaisesRegex(ValueError, "一致しません"):
                importer.import_archive(archive_path, catalogue, folder / "ambiguous")


if __name__ == "__main__":
    unittest.main()
