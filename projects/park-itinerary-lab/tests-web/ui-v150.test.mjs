import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedFacilities,weightButtons,selectableNodes,defaultSettings} from '../web/app.js';
test('snacks and popcorn form stable contiguous groups in both facility and wish lists',()=>{
 const original=[{id:'p1',category:'popcorn'},{id:'a',category:'attraction'},{id:'s1',category:'snack'},{id:'r',category:'restaurant'},{id:'p2',category:'popcorn'},{id:'s2',category:'snack'}];assert.deepEqual(orderedFacilities(original).map(item=>item.id),['a','r','s1','s2','p1','p2']);assert.deepEqual(original.map(item=>item.id),['p1','a','s1','r','p2','s2']);
});
test('required wishes have neutral disabled numbers and restore the remembered weight',()=>{
 const selection={id:'sea-ride',weight:5,required:true},required=weightButtons(selection);assert.equal((required.match(/ disabled /g)||[]).length,5);assert.equal(required.includes(' active'),false);assert.equal(required.includes('aria-pressed="true"'),false);assert.equal(selection.weight,5);selection.required=false;const optional=weightButtons(selection);assert.equal(optional.includes(' disabled '),false);assert.match(optional,/class="weight-button active" data-weight="5"/);assert.equal((optional.match(/aria-pressed="true"/g)||[]).length,1);
});
test('location pickers hide internal walking-graph nodes but keep named destinations',()=>{
 const entrance={id:'entrance',name:'入口'},canal={id:'canal',name:'運河沿い'};assert.deepEqual(selectableNodes({nodes:[entrance,{id:'osm-1',routingOnly:true},canal]}),[entrance,canal]);assert.equal(defaultSettings().gondolaAvoidHarbourShows,true);
});
