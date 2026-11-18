import test from 'node:test';
import assert from 'node:assert/strict';
import {clockMinute,parkTimeBounds,componentMinute,bindClockParts} from '../web/time-input.js';
class Field extends EventTarget {constructor(value=''){super();this.value=value;this.required=false;this.disabled=false;this.min='';this.max='';}}
function clock(value,bounds={min:480,max:1319}){
 const canonical=new Field(value),hour=new Field(),minute=new Field();let currentBounds=bounds,changes=0;canonical.addEventListener('change',()=>changes++);
 const controller=bindClockParts(canonical,hour,minute,{getBounds:()=>currentBounds});
 function key(field,key){const event=new Event('keydown',{cancelable:true});Object.defineProperty(event,'key',{value:key});field.dispatchEvent(event);assert.equal(event.defaultPrevented,true);}
 return {canonical,hour,minute,controller,key,changes:()=>changes,setBounds:value=>{currentBounds=value;controller.sync();}};
}
test('official hours constrain planning clocks and unknown dates use 08:00–21:59',()=>{
 const park={operatingCalendar:{'2026-11-18':{windows:[[570,1260]]},'2026-11-19':{windows:[[420,1380]]}}};
 assert.deepEqual(parkTimeBounds(park,'2026-11-18'),{min:570,max:1260});assert.deepEqual(parkTimeBounds(park,'2026-11-19'),{min:480,max:1319});assert.deepEqual(parkTimeBounds(park,'unknown'),{min:480,max:1319});
 assert.equal(clockMinute('08:59'),539);assert.equal(clockMinute('21:60'),null);assert.equal(clockMinute('24:00'),null);
});
test('actual arrow-key handlers clamp minutes without changing the hour',()=>{
 const view=clock('12:59');view.key(view.minute,'ArrowUp');assert.equal(view.canonical.value,'12:59');assert.equal(view.changes(),0);
 view.minute.value='00';view.minute.dispatchEvent(new Event('change'));assert.equal(view.canonical.value,'12:00');view.key(view.minute,'ArrowDown');assert.equal(view.canonical.value,'12:00');view.key(view.minute,'ArrowUp');assert.equal(view.canonical.value,'12:01');
});
test('actual hour keys stop at 08 and 21 and Home/End stay inside the day',()=>{
 const view=clock('21:40');view.key(view.hour,'ArrowUp');assert.equal(view.canonical.value,'21:40');view.key(view.hour,'Home');assert.equal(view.canonical.value,'08:40');view.key(view.hour,'ArrowDown');assert.equal(view.canonical.value,'08:40');view.key(view.hour,'End');assert.equal(view.canonical.value,'21:40');
});
test('direct component entry and native number changes apply the same clamps',()=>{
 const view=clock('14:20');view.minute.value='99';view.minute.dispatchEvent(new Event('change'));assert.equal(view.canonical.value,'14:59');view.hour.value='2';view.hour.dispatchEvent(new Event('change'));assert.equal(view.canonical.value,'08:59');view.minute.value='-1';view.minute.dispatchEvent(new Event('change'));assert.equal(view.canonical.value,'08:00');assert.equal(componentMinute(12*60+59,'minute',60),12*60+59);
});
test('partial opening hours set component endpoints and never roll past closing',()=>{
 const view=clock('10:15',{min:570,max:1260});view.key(view.hour,'Home');assert.equal(view.canonical.value,'09:30');assert.equal(view.minute.min,'30');view.key(view.minute,'ArrowDown');assert.equal(view.canonical.value,'09:30');view.key(view.hour,'End');assert.equal(view.canonical.value,'21:00');assert.equal(view.minute.max,'0');view.key(view.minute,'ArrowUp');assert.equal(view.canonical.value,'21:00');view.setBounds({min:600,max:1200});assert.equal(view.canonical.value,'20:00');
});
test('optional slots remain blank while required blank fields receive a valid clock',()=>{
 const optional=clock('');assert.equal(optional.hour.value,'');assert.equal(optional.minute.value,'');optional.minute.dispatchEvent(new Event('blur'));assert.equal(optional.canonical.value,'');optional.key(optional.hour,'ArrowUp');assert.equal(optional.canonical.value,'08:00');const required=clock('');required.canonical.required=true;required.controller.commit('hour');assert.equal(required.canonical.value,'08:00');
});
test('wish defaults use published park hours and fall back to the actual visit when hours are unknown',()=>{
 const park={operatingCalendar:{day:{windows:[[570,1230]]}}},visit={min:660,max:1110};
 assert.deepEqual(parkTimeBounds(park,'day',visit),{min:570,max:1230});
 assert.deepEqual(parkTimeBounds(park,'unknown',visit),visit);
});
