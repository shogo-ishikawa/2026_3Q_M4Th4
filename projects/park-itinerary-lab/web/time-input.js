/** Clock components clamp at their endpoints; hours and minutes never roll over. */
const controls=new WeakMap();
const DEFAULT_BOUNDS={min:480,max:1319};
const pad=value=>String(value).padStart(2,'0');
export const clockText=value=>`${pad(Math.floor(value/60))}:${pad(value%60)}`;
export function clockMinute(value){
  if(!/^\d{2}:\d{2}$/.test(value||''))return null;
  const [hour,minute]=value.split(':').map(Number);
  return hour<24&&minute<60?hour*60+minute:null;
}
export function parkTimeBounds(park,date){
  const windows=park?.operatingCalendar?.[date]?.windows;
  const known=Array.isArray(windows)?windows.filter(pair=>Array.isArray(pair)&&pair.length===2&&Number.isInteger(pair[0])&&Number.isInteger(pair[1])&&pair[0]<pair[1]):[];
  const min=known.length?Math.max(DEFAULT_BOUNDS.min,Math.min(...known.map(pair=>pair[0]))):DEFAULT_BOUNDS.min;
  const max=known.length?Math.min(DEFAULT_BOUNDS.max,Math.max(...known.map(pair=>pair[1]))):DEFAULT_BOUNDS.max;
  return max>min?{min,max}:DEFAULT_BOUNDS;
}
export function clampClock(value,bounds=DEFAULT_BOUNDS){
  const number=typeof value==='string'?clockMinute(value):value;
  return Math.max(bounds.min,Math.min(bounds.max,Number.isInteger(number)?number:bounds.min));
}
export function componentMinute(value,part,next,bounds=DEFAULT_BOUNDS){
  const current=clampClock(value,bounds),hour=Math.floor(current/60),minute=current%60;
  const number=Number.isFinite(Number(next))?Math.trunc(Number(next)):part==='hour'?hour:minute;
  const result=part==='hour'?Math.max(Math.floor(bounds.min/60),Math.min(Math.floor(bounds.max/60),number))*60+minute:hour*60+Math.max(0,Math.min(59,number));
  return clampClock(result,bounds);
}
/** This is a preference window, not the park's entry/exit or an acquired DPA slot. */
export function linkedWishWindow(changed,value,pair,bounds=DEFAULT_BOUNDS){
  const selected=clampClock(value,bounds);
  if(changed==='earliest'){
    const earliest=Math.min(selected,bounds.max-1);
    return {earliest,latest:Math.min(bounds.max,earliest+120)};
  }
  const latest=Math.max(selected,bounds.min+1);
  return {earliest:Math.max(bounds.min,latest-120),latest};
}

/** Bind real events separately so keyboard and direct entry use the same constraints. */
export function bindClockParts(canonical,hourInput,minuteInput,{getBounds=()=>DEFAULT_BOUNDS}={}){
  let syncing=false;
  const bounds=()=>getBounds(canonical)||DEFAULT_BOUNDS;
  function sync(){
    syncing=true;
    const limit=bounds(),raw=clockMinute(canonical.value),value=raw===null?null:clampClock(raw,limit);
    if(value!==null)canonical.value=clockText(value);
    const hour=value===null?null:Math.floor(value/60);
    hourInput.min=String(Math.floor(limit.min/60));hourInput.max=String(Math.floor(limit.max/60));
    minuteInput.min=String(hour===Math.floor(limit.min/60)?limit.min%60:0);
    minuteInput.max=String(hour===Math.floor(limit.max/60)?limit.max%60:59);
    hourInput.value=hour===null?'':pad(hour);minuteInput.value=value===null?'':pad(value%60);
    hourInput.disabled=canonical.disabled;minuteInput.disabled=canonical.disabled;
    syncing=false;
  }
  function commit(part){
    if(syncing)return;
    const previous=canonical.value;
    if(hourInput.value.trim()===''&&minuteInput.value.trim()===''&&!canonical.required)canonical.value='';
    else {
      const limit=bounds(),fallback=clockMinute(canonical.value)??limit.min;
      const hour=hourInput.value.trim()===''?Math.floor(fallback/60):Number(hourInput.value);
      const minute=minuteInput.value.trim()===''?fallback%60:Number(minuteInput.value);
      const current=part==='hour'?componentMinute(fallback,'minute',minute,limit):componentMinute(fallback,'hour',hour,limit);
      canonical.value=clockText(componentMinute(current,part,part==='hour'?hour:minute,limit));
    }
    sync();
    if(canonical.value!==previous){canonical.dispatchEvent(new Event('input',{bubbles:true}));canonical.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  for(const [part,input] of [['hour',hourInput],['minute',minuteInput]]){
    input.addEventListener('input',event=>event.stopPropagation());
    input.addEventListener('change',event=>{event.stopPropagation();commit(part);});
    input.addEventListener('keydown',event=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      const low=Number(input.min),high=Number(input.max),blank=input.value.trim()==='',number=blank?low:Number(input.value);
      input.value=String(event.key==='Home'?low:event.key==='End'?high:Math.max(low,Math.min(high,blank?low:number+(event.key==='ArrowUp'?1:-1))));
      commit(part);
    });
    input.addEventListener('blur',()=>commit(part));
  }
  canonical.addEventListener('change',sync);sync();
  return {sync,commit};
}

/** Retain canonical field IDs and change events for the settings and wish editors. */
export function enhanceTimeInputs(root,{getBounds=()=>DEFAULT_BOUNDS}={}){
  for(const input of root.querySelectorAll('input[type="time"]')){
    const document=input.ownerDocument,label=input.closest('label');
    const labelText=input.getAttribute('aria-label')||label?.textContent.trim()||'時刻';
    const box=document.createElement('span');box.className='clamped-time';box.setAttribute('role','group');box.setAttribute('aria-label',labelText);
    const hour=document.createElement('input'),minute=document.createElement('input'),separator=document.createElement('span');
    for(const [part,element,title] of [['hour',hour,'時'],['minute',minute,'分']]){
      element.type='number';element.step='1';element.inputMode='numeric';element.className='clock-component';element.dataset.timePart=part;
      if(input.id)element.id=`${input.id}-${part}`;
      element.setAttribute('aria-label',`${labelText}（${title}）`);element.setAttribute('autocomplete','off');element.required=input.required;
    }
    separator.className='clock-separator';separator.textContent=':';separator.setAttribute('aria-hidden','true');box.append(hour,separator,minute);
    input.type='hidden';input.dataset.clampedTime='true';input.insertAdjacentElement('afterend',box);
    if(label){const field=document.createElement('div');field.className=`time-field ${label.className||''}`.trim();while(label.firstChild)field.append(label.firstChild);label.replaceWith(field);}
    const controller=bindClockParts(input,hour,minute,{getBounds});controls.set(input,controller);
    if(!input.required){const clear=document.createElement('button');clear.type='button';clear.className='clock-clear';clear.textContent='×';clear.setAttribute('aria-label',`${labelText}をクリア`);clear.addEventListener('click',()=>{input.value='';controller.sync();input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));hour.focus();});box.append(clear);}
  }
  for(const input of root.querySelectorAll('input[data-clamped-time]'))controls.get(input)?.sync();
}
