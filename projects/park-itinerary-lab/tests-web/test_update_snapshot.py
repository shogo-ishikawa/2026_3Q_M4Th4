import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/f'{name}.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
updater=load('update_park_data');archive=load('archive_wait_history');collector=load('collect_wait_data');seeder=load('seed_wait_model')


class SnapshotTests(unittest.TestCase):
    def test_multiple_service_windows_and_all_dates_are_preserved(self):
        html='<li data-categorize="food"><a href="/tdl/restaurant/detail/1/"><h3 class="heading3">Cafe</h3><div class="date-20261117">9:00 - 11:00 / 13:00 - 21:00</div><div class="date-20261118">終日運営・公演中止</div></a></li>'
        record=updater.parse_list(html,'2026-11-17','land')[0]
        self.assertEqual(record['windows'],[[540,660],[780,1260]])
        self.assertTrue(record['dailySchedules']['2026-11-18']['closed'])
        base={'parks':[{'id':'land','activities':[{'id':'land-cafe','sourceUrl':record['sourceUrl'],'category':'cafe','node':'unchanged','duration':40,'cost':1000,'baseWait':15}]}]}
        result,_=updater.refresh_catalogue(base,[record],'2026-11-17','2026-11-16')
        activity=result['parks'][0]['activities'][0]
        self.assertEqual(activity['checkedOn'],'2026-11-16')
        self.assertEqual(activity['operatingDate'],'2026-11-17')
        self.assertEqual(activity['dailySchedules']['2026-11-18']['closed'],True)
        self.assertEqual((activity['node'],activity['duration'],activity['cost'],activity['baseWait']),('unchanged',40,1000,15))

    def test_unannounced_future_dash_is_never_a_confirmed_closure(self):
        html='<li data-categorize="ride"><a href="/tdl/attraction/detail/1/"><h3 class="heading3">Ride</h3><div class="date-20261117">ー 運営/公演予定</div><div class="date-20270115">ー 運営/公演予定</div><div class="date-20261118">9:00 - 21:00</div></a></li>'
        records=updater.parse_list(html,'2026-11-17','land')
        self.assertFalse(records[0]['hasConfirmedSchedule'])
        original={'parks':[{'id':'land','activities':[{'id':'land-a','category':'attraction','sourceUrl':records[0]['sourceUrl'],'dailySchedules':{'2027-01-15':{'closed':True}},'closedDates':[]}]}]}
        result,_=updater.refresh_catalogue(original,records,'2026-11-17','2026-11-17')
        activity=result['parks'][0]['activities'][0]
        self.assertNotIn('2026-11-17',activity.get('dailySchedules',{}))
        self.assertNotIn('2027-01-15',activity.get('dailySchedules',{}))
        self.assertEqual(activity['closedDates'],[])
        self.assertFalse(activity['dailySchedules']['2026-11-18']['closed'])

    def test_closure_intervals_open_ended_and_single_day(self):
        html='<ul>'+''.join(f'<li><a href="/tds/attraction/detail/{i}/"><p class="heading3">Ride{i}</p><p>{period}</p></a></li>' for i,period in enumerate(['2026/11/17 - 2026/12/1','2026/12/5','2026/10/1 - 未定']))+'</ul>'
        result=updater.parse_stops(html,'sea','https://www.tokyodisneyresort.jp/tds/monthly/stop/')
        self.assertEqual([(r['startDate'],r['endDate']) for r in result],[('2026-11-17','2026-12-01'),('2026-12-05','2026-12-05'),('2026-10-01',None)])

    def test_events_include_future_text_without_inventing_program_end(self):
        html='<a href="/treasure/christmas2026/"><h3 class="heading3">Christmas</h3><p>2026年11月11日（水）～12月25日（金）</p></a><a href="/programme/"><h3 class="heading3">Programme</h3><p>2026年9月30日～</p></a><p class="text">スペシャルイベント「Summer」<br>2027年7月2日（金）～8月31日（火）<br><br>お正月のスペシャルイベント<br>2028年1月1日～1月10日</p>'
        events=updater.parse_events(html,'land','https://www.tokyodisneyresort.jp/tdl/event.html')
        self.assertEqual(len(events),3)
        self.assertEqual(events[-1]['endDate'],'2028-01-10')
        self.assertEqual(events[1]['name'],'Summer')
        self.assertEqual(updater.japanese_range('2026年12月20日～1月5日'),('2026-12-20','2027-01-05'))

    def test_published_seed_retains_date_facts_but_reviewed_source_controls_costs(self):
        base={'parks':[{'id':'land','nodes':[{'id':'a','x':10}],'events':[],'activities':[{'id':'land-a','sourceUrl':'https://example.test/a','baseWait':50,'cost':2000,'dpa':{'price':1500},'menuCheckedOn':'2026-11-18','menuItems':['new']}]}]}
        old={'parks':[{'id':'land','nodes':[{'id':'a','x':20}],'events':[],'activities':[{'id':'land-a','sourceUrl':'https://example.test/a','baseWait':999,'cost':999,'dpa':None,'dailySchedules':{'2026-11-18':{'closed':True}},'menuCheckedOn':'2026-11-17','menuItems':['old']}]}]}
        result=updater.seed_dynamic_catalogue(base,old)['parks'][0]
        self.assertEqual(result['nodes'],base['parks'][0]['nodes'])
        activity=result['activities'][0]
        self.assertEqual((activity['baseWait'],activity['cost'],activity['dpa']['price']),(50,2000,1500))
        self.assertTrue(activity['dailySchedules']['2026-11-18']['closed'])
        self.assertEqual(activity['menuItems'],['new'])

    def test_official_closures_and_neutral_new_event_preserve_known_event_id(self):
        url='https://www.tokyodisneyresort.jp/tdl/attraction/detail/1/'
        base={'parks':[{'id':'land','activities':[{'id':'land-a','sourceUrl':url,'node':'fixed'}],'events':[{'id':'christmas','name':'Christmas','startDate':'2026-11-11','endDate':'2026-12-24','multiplier':1.2}]}]}
        bundle={'records':[],'stops':[{'parkId':'land','sourceUrl':'https://www.tokyodisneyresort.jp/tdl/monthly/stop/','records':[{'sourceUrl':url,'startDate':'2026-11-20','endDate':'2026-11-21'}]}],'events':[{'parkId':'land','name':'Christmas','startDate':'2026-11-11','endDate':'2026-12-25','sourceUrl':'https://www.tokyodisneyresort.jp/treasure/christmas/'},{'parkId':'land','name':'New year','startDate':'2027-01-01','endDate':'2027-01-11','sourceUrl':'https://www.tokyodisneyresort.jp/tdl/event.html'}],'errors':[]}
        result,_=updater.apply_official_updates(base,bundle,'2026-11-17','2026-11-17');park=result['parks'][0]
        self.assertEqual(park['events'][0]['id'],'christmas');self.assertEqual(park['events'][0]['endDate'],'2026-12-25')
        self.assertEqual(park['events'][1]['multiplier'],1)
        self.assertEqual(park['activities'][0]['closedPeriods'][0]['startDate'],'2026-11-20')
        self.assertEqual(result['pipelineVersion'],2)

    def test_calendar_links_are_official_and_park_scoped(self):
        html='<a href="/tdl/monthly/calendar/202612/">12月</a><a href="/tdl/monthly/calendar.html?year=2027&month=1">1月</a><a href="https://evil.test/tdl/monthly/calendar.html?year=2027&month=2">fake</a><a href="/tds/monthly/calendar.html?year=2027&month=1">sea</a>'
        self.assertEqual(updater.calendar_links(html,'land'),['https://www.tokyodisneyresort.jp/tdl/monthly/calendar.html?year=2027&month=1','https://www.tokyodisneyresort.jp/tdl/monthly/calendar/202612/'])


class ArchiveTests(unittest.TestCase):
    def test_archive_never_publishes_private_provider_records_and_retains_months(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);history=root/'history';history.mkdir()
            row={'date':'2026-11-17','activityId':'land-a','time':540,'wait':5,'openingMinute':540,'source':'queue-times','privatePayload':{'anything':'removed'}}
            (root/'observations.json').write_text(json.dumps([row,{**row,'time':555,'wait':35},{**row,'source':'themeparks-wiki'},{**row,'date':'2026-11-18'}]))
            (history/'2024-11.json').write_text('[]')
            (history/'ignore.json').write_text('["not loaded"]')
            index=archive.update_archive(root,dt.date(2026,11,17))
            values=json.loads((history/'2026-11.json').read_text())
            self.assertEqual(len(values),2)
            self.assertTrue(all(r['source']=='queue-times' for r in values))
            self.assertTrue(all('privatePayload' not in r for r in values))
            self.assertFalse((history/'2024-11.json').exists())
            self.assertTrue((history/'ignore.json').exists())
            self.assertEqual(index['samples'],2)
            archive.update_archive(root,dt.date(2026,11,17));self.assertEqual(json.loads((history/'2026-11.json').read_text()),values)

    def test_opening_buckets_keep_early_rise_and_later_buckets_deduplicate(self):
        row={'date':'2026-11-17','activityId':'land-a','time':543,'wait':5,'openingMinute':540,'source':'queue-times'}
        values=collector.merge_observations([row],[{**row,'time':558,'wait':35},{**row,'time':720,'wait':50},{**row,'time':735,'wait':60}],dt.date(2026,11,17))
        self.assertEqual([r['time'] for r in values],[543,558,735])
        self.assertEqual([collector.bucket(r) for r in values],[540,550,720])
        self.assertEqual([archive.bucket(r) for r in values],[540,550,720])

    def test_observations_capture_weather_holiday_and_actual_opening(self):
        snapshot={'fetchedAt':'2026-11-17T00:03:00Z','rides':[{'isOpen':True,'updatedAt':'2026-11-17T00:01:00Z','activityId':'land-a','wait':5}]}
        park={'id':'land','events':[],'operatingCalendar':{'2026-11-17':{'windows':[[540,1260]]}}}
        row=collector.to_observations(snapshot,park,'rain',{'temperature':11.2,'precipitation':2.5},{'holidays':[{'date':'2026-11-17','name':'Fixture holiday'}]})[0]
        self.assertEqual((row['temperature'],row['precipitation'],row['openingMinute'],row['holiday']),(11.2,2.5,540,True))


class ModelSeedTests(unittest.TestCase):
    def model(self,park,days=7,usable=True,mae=5):
        return {'schemaVersion':1,'method':'ridge-regression','parkId':park,'status':'trained','usable':usable,'days':days,'samples':120,'trainedAt':'2026-11-17T12:00:00Z','beforeDate':'2026-11-17','firstDate':'2026-11-01','lastDate':'2026-11-16','activityIds':[park+'-a'],'coefficients':[1]*8,'validation':{'method':'later-days-holdout','trainThrough':'2026-11-13','testFrom':'2026-11-14','testThrough':'2026-11-16','testSamples':20,'modelMae':mae,'baselineMae':20}}

    def test_initial_usable_bundle_survives_cold_or_corrupt_remote_data(self):
        bundled={'parks':[self.model('land'),self.model('sea')]}
        published={'parks':[{**self.model('land'),'status':'insufficient-data','usable':False,'days':0},{**self.model('sea'),'validation':None}]}
        result=seeder.select_models(bundled,published,ROOT/'web/wait-model.js')
        self.assertTrue(all(m['usable'] and m['validation'] for m in result['parks']))

    def test_broader_usable_published_history_is_not_replaced_by_shorter_bundle(self):
        bundled={'parks':[self.model('land',days=7),self.model('sea',days=7)]}
        published={'parks':[self.model('land',days=30),self.model('sea',days=30)]}
        result=seeder.select_models(bundled,published,ROOT/'web/wait-model.js')
        self.assertEqual([m['days'] for m in result['parks']],[30,30])

    def test_equal_validation_period_prefers_lower_error_over_newer_timestamp(self):
        bundled={'parks':[self.model('land',mae=10),self.model('sea',mae=10)]}
        published={'parks':[{**self.model('land',mae=3),'trainedAt':'2026-11-16T12:00:00Z'},{**self.model('sea',mae=3),'trainedAt':'2026-11-16T12:00:00Z'}]}
        result=seeder.select_models(bundled,published,ROOT/'web/wait-model.js')
        self.assertEqual([m['validation']['modelMae'] for m in result['parks']],[3,3])

    def test_unreadable_published_json_does_not_block_seeded_queue_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'model.json';path.write_text('{broken')
            subprocess.run(['python',str(ROOT/'scripts/seed_wait_model.py'),'--published',str(path),'--output',str(path)],check=True,capture_output=True,text=True)
            self.assertEqual([m['parkId'] for m in json.loads(path.read_text())['parks']],['land','sea'])


if __name__=='__main__':unittest.main()
