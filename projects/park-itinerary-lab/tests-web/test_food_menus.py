import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('food_menus', ROOT/'scripts/update_food_menus.py')
food = importlib.util.module_from_spec(spec)
spec.loader.exec_module(food)
VENUE = 'https://www.tokyodisneyresort.jp/tds/restaurant/detail/450/'
MENU = 'https://www.tokyodisneyresort.jp/tds/restaurant/food/450/'


def venue():
    return {'id':'sea-snack-450','name':'sample','category':'snack','sourceUrl':VENUE,'duration':10,'node':'a','baseWait':10}


class FoodMenuTests(unittest.TestCase):
    def test_follows_actual_menu_link_and_rejects_unrelated_navigation(self):
        page='<a href="/tds/restaurant.html">メニュー/レストラン</a><a href="/tds/restaurant/food/450/">店舗メニュー</a>'
        self.assertEqual(food.parse_menu_link(page, VENUE), MENU)
        with self.assertRaises(ValueError):
            food.parse_menu_link('<a href="https://example.com/tds/restaurant/food/450/">店舗メニュー</a>', VENUE)
        for url in ['http://www.tokyodisneyresort.jp/food/1/','https://evil.tokyodisneyresort.jp/food/1/','https://user:secret@www.tokyodisneyresort.jp/food/1/']:
            with self.assertRaises(ValueError):food.official_url(url,VENUE)

    def test_representative_food_excludes_souvenirs_future_items_and_footer(self):
        page='''<h2>おすすめメニュー</h2><a href="/food/1/"><h3>スーベニアカップ</h3></a>
        <a href="/food/2/"><h3>来月のケーキ</h3><div>[販売期間] 2026年12月1日 ～ 2026年12月25日</div></a>
        <h2>ハウスカレー</h2><a href="/food/3/"><h3>チキンカレー</h3></a>
        <a href="/food/4/"><h3>ポークカレー</h3></a><a href="/food/5/"><h3>野菜カレー</h3></a>
        <h2>販売店舗</h2><a href="/tds/restaurant/detail/450/"><h3>店舗名</h3></a>'''
        items=food.parse_menu_items(page,MENU,'restaurant','2026-11-17')
        self.assertEqual([item['name'] for item in items], ['チキンカレー','ポークカレー','野菜カレー'])
        self.assertEqual(items[0]['url'],'https://www.tokyodisneyresort.jp/food/3/')

    def test_food_containing_sauce_is_kept_but_sauce_only_toppings_are_omitted(self):
        page='<h2>スウィーツ</h2><a href="/food/1/"><h3>ワッフル、メイプルソース</h3></a><a href="/food/2/"><h3>スパイシーハリッサソース</h3></a>'
        self.assertEqual([i['name'] for i in food.parse_menu_items(page,MENU,'cafe','2026-11-17')],['ワッフル、メイプルソース'])

    def test_popcorn_flavours_are_read_from_the_same_venue_menu(self):
        page='''<h2>スナック</h2><a href="/food/1/"><h3>ポップコーン、レギュラーボックス</h3><p>#ミルクチョコレート味</p></a>
        <a href="/food/2/"><h3>ポップコーン、バケット付き</h3><p>#ミルクチョコレート味</p></a><a href="/food/3/"><h3>スパイシーハリッサソース</h3></a>'''
        self.assertEqual(food.parse_menu_items(page,MENU,'popcorn','2026-11-17'),[{'name':'ポップコーン（ミルクチョコレート味）','url':'https://www.tokyodisneyresort.jp/food/1/'}])

    def test_failed_refresh_keeps_last_verified_menu_and_only_changes_food_fields(self):
        activity=venue();activity.update({'menuUrl':MENU,'menuItems':[{'name':'うきわまん','url':'https://www.tokyodisneyresort.jp/food/3/'}],'menuCheckedOn':'2026-11-16','menuStatus':'verified'})
        ride={'id':'sea-ride','category':'attraction','duration':5,'node':'b'}
        catalogue={'version':'1','extra':'keep','parks':[{'id':'sea','events':[{'id':'christmas'}],'activities':[activity,ride]}]}
        before=copy.deepcopy(catalogue)
        def failed(url):raise OSError('network unavailable')
        result,report=food.update_catalogue(catalogue,'2026-11-17',fetcher=failed)
        self.assertEqual(result['parks'],before['parks'])
        self.assertEqual(result['extra'],'keep');self.assertEqual(report['updated'],0)
        self.assertEqual(len(report['errors']),1)

    def test_refresh_obtains_two_verified_pages_and_atomic_replacement(self):
        pages={VENUE:'<a href="/tds/restaurant/food/450/">店舗メニュー</a>',MENU:'<h2>スナック</h2><a href="/food/3/"><h3>うきわまん</h3></a>'}
        result,report=food.update_catalogue({'parks':[{'id':'sea','activities':[venue()]}]},'2026-11-17',fetcher=pages.__getitem__)
        a=result['parks'][0]['activities'][0]
        self.assertEqual(report['updated'],1);self.assertEqual(a['menuUrl'],MENU)
        self.assertEqual(a['menuCheckedOn'],'2026-11-17');self.assertEqual(a['menuStatus'],'verified')
        self.assertEqual(a['duration'],10);self.assertEqual(a['node'],'a');self.assertEqual(a['baseWait'],10)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'catalogue.json';path.write_text('{}')
            food.atomic_json(path,result)
            self.assertEqual(json.loads(path.read_text()),result)
            self.assertEqual([p.name for p in path.parent.iterdir()],['catalogue.json'])

    def test_shipped_food_links_have_primary_sources_and_check_dates(self):
        catalogue=json.loads((ROOT/'web/data/parks.json').read_text())
        activities=[a for p in catalogue['parks'] for a in p['activities'] if a['category'] in food.FOOD]
        self.assertEqual(len(activities),48)
        for activity in activities:
            self.assertEqual(activity['menuStatus'],'verified',activity['id'])
            self.assertTrue(activity['menuUrl'].startswith('https://www.tokyodisneyresort.jp/'),activity['id'])
            self.assertIn('/restaurant/food/',activity['menuUrl'])
            self.assertRegex(activity['menuCheckedOn'],r'^\d{4}-\d{2}-\d{2}$')
            for item in activity['menuItems']:
                self.assertTrue(item['name']);self.assertTrue(item['url'].startswith('https://www.tokyodisneyresort.jp/food/'))


if __name__=='__main__':unittest.main()
