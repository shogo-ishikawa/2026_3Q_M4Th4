"""Coverage, temporal availability and graph safeguards for the complete food list."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

PROJECT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(PROJECT/'scripts'))
import expand_food_catalogue as expand


def row(name,venue_id,area='ワールドバザール',tags='["6105"]',menu=True):
    link=f'<a href="/tdl/restaurant/food/{venue_id}/">店舗メニュー</a>' if menu else ''
    return f'''<li data-categorize="1" data-tags='{tags}'><a href="/tdl/restaurant/detail/{venue_id}/"><p class="area">{area}</p><h3 class="heading3">{name}</h3></a>{link}<div class="date-20261118">10:00 - 18:00</div></li>'''


class FoodCatalogueTests(unittest.TestCase):
    def setUp(self):
        self.catalogue=json.loads((PROJECT/'web/data/parks.json').read_text())
        # Remove one reviewed venue so each fixture exercises addition rather than refresh.
        park=self.catalogue['parks'][0]
        removed={a['id'] for a in park['activities'] if a['sourceUrl'].endswith('/317/')}
        removed_nodes={a['node'] for a in park['activities'] if a['id'] in removed}
        park['activities']=[a for a in park['activities'] if a['id'] not in removed]
        park['nodes']=[n for n in park['nodes'] if n['id'] not in removed_nodes]
        park['edges']=[e for e in park['edges'] if e['from'] not in removed_nodes and e['to'] not in removed_nodes]

    def test_only_reviewed_in_park_venues_receive_graph_connections(self):
        source=row('アイスクリームコーン','317')+row('unreviewed venue','99999')+row('outside venue','307','パーク外')
        original=copy.deepcopy(self.catalogue)
        result,report=expand.expand_catalogue(self.catalogue,{'land':source,'sea':''},'2026-11-17')
        self.assertEqual(len(report['added']),1)
        self.assertEqual(len(report['unplaced']),1)
        self.assertEqual(report['excluded'][0]['reason'],'outside-park')
        park=result['parks'][0]
        added=next(a for a in park['activities'] if a['sourceUrl'].endswith('/317/'))
        self.assertEqual(added['category'],'snack')
        self.assertEqual(added['dailySchedules']['2026-11-18']['windows'],[[600,1080]])
        self.assertEqual(added['menuUrl'],'https://www.tokyodisneyresort.jp/tdl/restaurant/food/317/')
        self.assertEqual(added['costSource'],'planning-budget')
        self.assertEqual(added['windowsDate'],'2026-11-18')
        edge=next(e for e in park['edges'] if e['to']==added['node'])
        self.assertEqual(edge['from'],'world')
        self.assertEqual(edge['distanceSource'],'schematic-access-estimate')
        self.assertEqual(self.catalogue,original)

    def test_closed_interval_and_reserved_dining_are_kept_as_constraints(self):
        source=row('reserved venue','336','ウエスタンランド','["502"]')+'''<li><a href="/tdl/restaurant/detail/336/"><h3 class="heading3">reserved venue</h3></a>2026/11/1 - 2026/11/20</li>'''
        park=self.catalogue['parks'][0]
        park['activities']=[a for a in park['activities'] if not a['sourceUrl'].endswith('/336/')]
        # Its old display node may remain; it must never acquire a second activity with the same node ID.
        park['nodes']=[n for n in park['nodes'] if n['id']!='visit-land-restaurant-336']
        park['edges']=[e for e in park['edges'] if e['to']!='visit-land-restaurant-336' and e['from']!='visit-land-restaurant-336']
        result,_=expand.expand_catalogue(self.catalogue,{'land':source,'sea':''},'2026-11-17')
        activity=next(a for a in result['parks'][0]['activities'] if a['sourceUrl'].endswith('/336/'))
        self.assertEqual(activity['access'],'reservation')
        self.assertTrue(activity['reservationRequired'])
        self.assertEqual(activity['closedPeriods'][0]['endDate'],'2026-11-20')
        self.assertEqual(activity['closedPeriods'][0]['origin'],'official')

    def test_menu_links_come_from_the_verified_list_and_failed_refresh_keeps_old_menu(self):
        catalogue,_=expand.expand_catalogue(self.catalogue,{'land':row('ice shop','317'),'sea':''},'2026-11-17')
        activity=next(a for a in catalogue['parks'][0]['activities'] if a['sourceUrl'].endswith('/317/'))
        activity.update(menuItems=[{'name':'Previous item','url':'https://www.tokyodisneyresort.jp/food/123/'}],menuCheckedOn='2026-11-16',menuStatus='verified')
        def fail(url):raise TimeoutError('timeout')
        result,report=expand.refresh_listed_menus(catalogue,'2026-11-17',fetcher=fail)
        preserved=next(a for a in result['parks'][0]['activities'] if a['id']==activity['id'])
        self.assertEqual(preserved['menuItems'][0]['name'],'Previous item')
        self.assertEqual(preserved['menuCheckedOn'],'2026-11-16')
        self.assertEqual(report['updated'],0)
        self.assertGreater(len(report['errors']),0)
        parsed=expand.parse_food_list(row('ice shop','317',menu=False),'2026-11-17','land')
        self.assertIsNone(parsed[0]['menuUrl'])

    def test_full_catalogue_matches_checked_official_lists_and_graphs_are_connected(self):
        counts={p['id']:sum(a['category'] in expand.menus.FOOD for a in p['activities']) for p in self.catalogue['parks']}
        # setUp removed the single test venue.
        self.assertEqual(counts,{'land':59,'sea':66})
        full=json.loads((PROJECT/'web/data/parks.json').read_text())
        for park in full['parks']:
            nodes={n['id'] for n in park['nodes']}
            self.assertEqual(len(nodes),len(park['nodes']))
            self.assertEqual(len({a['id'] for a in park['activities']}),len(park['activities']))
            reached={park['entryNode']}
            while True:
                updated=reached|{e['to'] for e in park['edges'] if e['from'] in reached}|{e['from'] for e in park['edges'] if e['to'] in reached}
                if updated==reached:break
                reached=updated
            self.assertEqual(reached,nodes)
            for activity in park['activities']:
                self.assertIn(activity['node'],nodes)
                if activity['category'] in expand.menus.FOOD:
                    self.assertNotEqual(activity['area'],'パーク外')
                    self.assertIn('/restaurant/detail/',activity['sourceUrl'])
                    self.assertIn('/restaurant/food/',activity['menuUrl'])
            self.assertFalse(any('マゼランズ・ラウンジ'==a['name'] for a in park['activities']))


if __name__=='__main__':unittest.main()
