import test from 'node:test';
import assert from 'node:assert/strict';
import {setWorkflowTab,toggleWantedSelection,removePlannedRest,defaultSettings,resetForNewVisitDay,chooseCatalogue,catalogueRefreshNotice} from '../web/app.js';

function workspace(){
 const elements=new Map();
 for(const key of ['Wishlist','Schedule']){
  const tab={attrs:{},tabIndex:0,focused:false,setAttribute(name,value){this.attrs[name]=value;},focus(){this.focused=true;}};
  const panel={hidden:key==='Schedule',unsavedText:'編集中の条件'};
  elements.set(`workflow${key}Tab`,tab);elements.set(`workflow${key}`,panel);
 }
 return {getElementById:id=>elements.get(id)};
}

test('switching between wishes and schedule preserves edits and moves the accessible tab stop',()=>{
 const root=workspace();
 setWorkflowTab(root,'schedule',{focus:true});
 assert.equal(root.getElementById('workflowWishlist').hidden,true);
 assert.equal(root.getElementById('workflowSchedule').hidden,false);
 assert.equal(root.getElementById('workflowScheduleTab').attrs['aria-selected'],'true');
 assert.equal(root.getElementById('workflowScheduleTab').tabIndex,0);
 assert.equal(root.getElementById('workflowWishlistTab').tabIndex,-1);
 assert.equal(root.getElementById('workflowScheduleTab').focused,true);
 setWorkflowTab(root,'wishlist');
 assert.equal(root.getElementById('workflowSchedule').hidden,true);
 assert.equal(root.getElementById('workflowWishlist').hidden,false);
 assert.equal(root.getElementById('workflowWishlist').unsavedText,'編集中の条件');
 assert.throws(()=>setWorkflowTab(root,'unknown'),RangeError);
});

test('pressing a checked facility removes it without losing other wishes or purchase history',()=>{
 const another={id:'land-another',weight:5,required:true};
 const settings={selections:[{id:'land-ride',weight:4},another],purchases:[{id:'land-ride',cost:2000}]};
 assert.equal(toggleWantedSelection(settings,{id:'land-ride'}),false);
 assert.deepEqual(settings.selections,[another]);
 assert.equal(settings.purchases[0].cost,2000);
 const next={id:'land-ride',weight:3};assert.equal(toggleWantedSelection(settings,next),true);
 assert.equal(settings.selections.at(-1),next);
});

test('deleting one generated break keeps the chosen interval and every other break',()=>{
 const settings={restEvery:90,restMinutes:10,fixedBreaks:[{id:'lunch-rest'},{id:'snack-rest'}],excludedAutoBreaks:[]};
 assert.equal(removePlannedRest(settings,{kind:'rest',autoBreakId:'hub:land-ride'}),true);
 assert.deepEqual(settings.excludedAutoBreaks,['hub:land-ride']);
 removePlannedRest(settings,{kind:'rest',autoBreakId:'hub:land-ride'});
 assert.equal(settings.excludedAutoBreaks.length,1);
 assert.equal(settings.restEvery,90);assert.equal(settings.restMinutes,10);
 assert.equal(removePlannedRest(settings,{kind:'rest',fixedBreakId:'snack-rest'}),true);
 assert.deepEqual(settings.fixedBreaks,[{id:'lunch-rest'}]);
 assert.equal(removePlannedRest(settings,{kind:'rest',autoBreakId:'hub:other',preserved:true}),false);
 assert.equal(removePlannedRest(settings,{kind:'walk',autoBreakId:'hub:other'}),false);
 assert.deepEqual(settings.excludedAutoBreaks,['hub:land-ride']);
});

test('a different visit day clears individual automatic-break exclusions',()=>{
 const state={settings:{...defaultSettings(),excludedAutoBreaks:['hub:land-ride'],liveData:{parkId:'land'},liveNotice:'前の日の取得結果',waitAsOf:123},result:{},parkStates:{land:{}}};
 assert.equal(defaultSettings().walkCrowdMode,'estimate');
 resetForNewVisitDay(state);assert.deepEqual(state.settings.excludedAutoBreaks,[]);assert.equal(state.settings.liveData,undefined);assert.equal(state.settings.liveNotice,undefined);assert.equal(state.settings.waitAsOf,undefined);
});


test('a newer refresh of an older catalogue cannot remove newly added food venues',()=>{
 const bundled={pipelineVersion:2,version:'1.1.0',fetchedAt:'2026-11-17T12:00:00Z',parks:[{activities:['new venue']}]};
 const previous={pipelineVersion:2,version:'1.0.0',fetchedAt:'2026-11-17T14:00:00Z',parks:[{activities:[]}],updateStatus:'failed',refreshAttempt:{checkedAt:'2026-11-17T15:00:00Z',status:'failed'}};
 const result=chooseCatalogue(bundled,previous);assert.equal(result.parks,bundled.parks);assert.match(catalogueRefreshNotice(result),/取得できませんでした/);
 const newer={...previous,version:'1.2.0'};assert.equal(chooseCatalogue(bundled,newer),newer);
});
