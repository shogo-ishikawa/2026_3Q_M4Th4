import {PipeSPH,resolveQuality} from './sph.js';
import {LaminarPipeSPH,LAMINAR_RESOLUTIONS} from './laminar-pipe.js';
import {friction,physical,regime,normalizedProfile} from './physics.js';
import {laminarAccuracy} from './accuracy.js';
import {createLearningTools} from './learning-tools.js';
import {MAX_JSON_CHARACTERS,normaliseRecords,exportExperiment,readExperiment} from './experiment-state.js';
const $=id=>document.getElementById(id),num=(n,d=0)=>n.toLocaleString('ja-JP',{maximumFractionDigits:d,minimumFractionDigits:d});
const labels={laminar:'層流',transition:'遷移域',turbulent:'乱流'};
const colors={ink:'#223e4c',muted:'#788b94',grid:'#e8edee',teal:'#0d8d97',navy:'#436176',orange:'#e58146'};
let appliedRe=500,pendingRe=500,running=false,frame=0,last=0,diagnostics={},records=[],histories=[],profileBins=[];
let activeMode='laminar',modeNotice='',experimentLoadToken=0,experimentReading=false;
const RECORD_CACHE='reynolds-flow-lab.reference-records.v1';
function makeEngine(re,quality,mode,alpha=Number($('alpha').value)){return mode==='laminar'?new LaminarPipeSPH({re,quality,artificialViscosityAlpha:alpha}):new PipeSPH({re,quality,model:mode==='teaching',artificialViscosityAlpha:alpha})}
let engine=makeEngine(appliedRe,innerWidth<600?'standard':'high',activeMode);
$('quality').value=engine.quality;$('mode').value=activeMode;
let stepCostMs=0,lastRateTime=0,lastRateSim=0,simulationRate=0,lessonId=1,accuracyOverride=false,accuracyState={assessed:false,exceeded:false};
const isLaminar=()=>engine.engineKind==='axisymmetric-sph';
const learningTools=createLearningTools();
function qualityPending(){return $('quality').value!==engine.quality}
function qualityHelp(){const chosen=$('quality').value,radial=$('mode').value==='laminar';
for(const option of $('quality').options||[]){const count=resolveQuality(option.value).count;option.textContent=radial?`計算${LAMINAR_RESOLUTIONS[option.value]}粒子・表示${num(count)}点`:`${num(count)}粒子で3次元計算`}
$('alpha').disabled=radial;
$('qualityNote').textContent=radial?`半径方向の${LAMINAR_RESOLUTIONS[chosen]}粒子で速度を計算します。その結果を${num(resolveQuality(chosen).count)}点の動きで表示します。変更後は「この条件で実行」を押してください。`:`${num(resolveQuality(chosen).count)}粒子の動きを3次元で計算します。粒子数が多いほど時間がかかります。`;
}
window.flowLab={get engine(){return engine},get appliedRe(){return appliedRe},get pendingRe(){return pendingRe},get running(){return running},get records(){return records.slice()},get lesson(){return lessonId},get accuracy(){return {...accuracyState}},get accuracyOverride(){return accuracyOverride},get mode(){return activeMode},get diagnostics(){return diagnostics}};
function fit(canvas){const box=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,box.width),h=Math.max(1,box.height);if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);return {c,w,h}}
function reInput(re){if(!Number.isFinite(re))return;pendingRe=Math.min(100000,Math.max(100,Math.round(re)));$('reSlider').value=Math.log10(pendingRe);$('reNumber').value=pendingRe;const pending=pendingRe!==appliedRe||qualityPending();document.querySelector('.re-number').classList.toggle('pending',pending);$('applyStatus').textContent=pending?`Re ${num(pendingRe)} を選択中。「実行」で反映します。`:`Re ${num(appliedRe)}・${running?'計算中':'停止中'}`+(modeNotice?' · '+modeNotice:'')}
$('reSlider').addEventListener('input',e=>reInput(10**Number(e.target.value)));
$('reNumber').addEventListener('change',e=>{if(e.target.value===''){e.target.value=pendingRe;return}reInput(Number(e.target.value))});
$('reNumber').addEventListener('keydown',e=>{if(e.key==='Enter'){reInput(Number(e.target.value));apply()}});
document.querySelectorAll('[data-re]').forEach(b=>b.addEventListener('click',()=>reInput(Number(b.dataset.re))));
function setRunning(value){running=value;$('pause').textContent=running?'Ⅱ 一時停止':'▶ 再開';$('runState').textContent=running?'計算中':'一時停止';$('liveDot').classList.toggle('paused',!running);reInput(pendingRe)}
function clearProgress(){accuracyOverride=false;histories=[];profileBins=[];last=0;lastRateTime=0;lastRateSim=0;stepCostMs=0;simulationRate=0;$('error').hidden=true}
function apply(){cancelExperimentRead();try{let mode=$('mode').value;modeNotice='';if(mode==='laminar'&&pendingRe>=2300){mode='teaching';modeNotice='このReでは混合のイメージ表示へ切り替えました。'}const next=makeEngine(pendingRe,$('quality').value,mode);engine=next;activeMode=mode;appliedRe=pendingRe;$('mode').value=mode;clearProgress();qualityHelp();setRunning(true);updateStats();drawCharts();renderFlow();updateDiagnostics()}catch(e){setRunning(false);$('error').hidden=false;$('error').textContent='計算を開始できませんでした。条件を確認してください。'+e.message}}
$('quality').addEventListener('change',()=>{qualityHelp();reInput(pendingRe)});
$('alpha').addEventListener('change',()=>apply());$('apply').addEventListener('click',apply);$('pause').addEventListener('click',()=>setRunning(!running));
$('reset').addEventListener('click',()=>{cancelExperimentRead();const recovering=!$('error').hidden;engine.reset(appliedRe,engine.model);$('mode').value=activeMode;modeNotice='';clearProgress();qualityHelp();if(recovering)setRunning(true);renderFlow();drawCharts();updateDiagnostics()});
$('mode').addEventListener('change',()=>apply());
$('view').addEventListener('change',()=>{histories=[];renderFlow()});
function updateDyeLegend(){$('colorLegend').innerHTML=$('dye').checked?'<span>色は粒子の目印</span><i class="dye-gradient"></i><span>色を追って混合を見る</span>':'<span>流れの速さ u/U</span><i></i><span>0</span><span>2</span>';renderFlow()}
$('dye').addEventListener('change',updateDyeLegend);$('guides').addEventListener('change',renderFlow);$('trails').addEventListener('change',()=>{histories=[];renderFlow()});
const lessons={
1:{title:'中心と壁の近くではどちらが速い？',label:'実験1 · 水の速さを比べる',question:'「実験1」を押しましょう。中心付近の点と壁付近の点を見比べてください。長い矢印ほど速い流れを表します。',hint:'青は遅い流れを表します。黄色は速い流れです。下の数値も見比べてみましょう。',answer:'静止した壁に接する水の速さはゼロです。中心に近づくほど速くなります。流れが滑らかな層をなす状態を「層流」と呼びます。この実験は流れが十分に発達した状態から始まります。中心と壁の速度差が保たれるかを観察しましょう。「壁の近く」の表示点は壁から少し離れているので速さはゼロではありません。'},
2:{title:'流速を2倍にすると圧力損失はどうなる？',label:'実験2 · 水の速さと必要な圧力差を比べる',question:'同じ水と同じ太さの管を使います。Reを500から1,000にすると実際の平均流速は2倍になります。下の3つの倍率を見比べましょう。',hint:'画面の速さは平均を1とした比です。同じように動いて見えても実際の速さは違います。「平均流速U」のm/s表示で確認してください。',answer:'摩擦係数は抵抗を比べるための指標です。水を流すのに必要な圧力差そのものではありません。層流では平均流速を2倍にすると摩擦係数fD=64/Reは半分になります。圧力損失には流速の2乗も掛かるため0.5×2²=2倍です。摩擦係数が半分でも必要な圧力差は2倍になります。'},
3:{title:'色のついた水はどう混ざる？',label:'実験3 · 混合のイメージを見る',question:'色は水の動きを追う目印です。点が管の横方向にも動く様子を観察しましょう。この実験では混合を見せるための力を人工的に加えています。',hint:'「3次元SPHで自由に試す」では混合を見せる力を外せます。その場合は計算誤差にも注意が必要です。',answer:'乱流では流れが複雑に変動します。渦は水を横方向にも運びます。この実験ではその動きを見せるために渦状の力を加えています。自然に乱流へ変わる過程を予測した計算ではありません。表示している摩擦係数は円管の経験式から求めた値です。'}
};
function runLesson(id){lessonId=id;reInput(id===1?500:id===2?1000:20000);$('mode').value=id===3?'teaching':'laminar';$('alpha').value='0.035';$('dye').checked=id===3;$('guides').checked=id!==3;$('trails').checked=true;$('view').value='slice';$('lessonAnswer').open=false;apply();updateDyeLegend()}
for(const id of [1,2,3])$('lesson'+id).addEventListener('click',()=>runLesson(id));
$('lessonNext').addEventListener('click',()=>runLesson(lessonId>=1&&lessonId<3?lessonId+1:1));
function updateLesson(){if((lessonId===1&&(appliedRe!==500||activeMode!=='laminar'))||(lessonId===2&&(appliedRe!==1000||activeMode!=='laminar'))||(lessonId===3&&(appliedRe!==20000||activeMode!=='teaching'))){lessonId=0;$('lessonAnswer').open=false}const a=lessons[lessonId]||{title:'条件を一つ変えて流れを比べよう。',label:'自由実験',question:'Reや計算粒子数を一つずつ変えてみましょう。変える条件を一つに絞ると違いを見つけやすくなります。',hint:'この軸対称SPHはRe 2,300未満の層流用です。選択したままそれ以上のReで実行すると混合のイメージ表示へ切り替わります。',answer:'計算方法ごとに役割が違います。今回の軸対称SPHは横流れのない層流を計算します。3次元SPHでは横方向の動きも求めます。ただし長時間の計算には精度の課題が残っています。大きな数値欄と倍率欄とRe–f図は円管の式による値です。軸対称SPHでは壁付近の速度の変わり方から求めた摩擦係数も比較できます。'};
for(const id of [1,2,3])$('lesson'+id).setAttribute('aria-current',id===lessonId?'step':'false');$('lessonLabel').textContent=a.label;$('lessonTitle').textContent=a.title;$('lessonQuestion').textContent=a.question;$('lessonHint').textContent=a.hint;$('lessonAnswerText').textContent=a.answer;$('lessonNext').textContent=lessonId===1?'次へ：流速を2倍にする →':lessonId===2?'次へ：混合のイメージを見る →':'実験1からもう一度 →';
$('lessonModeStatus').textContent=isLaminar()?'軸対称SPH · まっすぐ流れる層流を計算':engine.model?'混合のイメージ表示 · 渦の外力あり':'3次元SPHの自由実験 · 補助外力なし';
learningTools.showLesson(lessonId,activeMode);
$('modeNote').textContent=isLaminar()?'中心から壁へ向かう半径方向に粒子を並べて速さを計算します。画面の点はその速さで動く目印です。横方向には流れないと仮定しています。':engine.model?'混合を見せるために渦を起こす力を加えています。速さの分布を整える力も使います。':'粒子の動きを3次元で計算します。長時間の計算では誤差が増える場合があります。精度表示も確認してください。';if(modeNotice)$('modeNote').textContent=modeNotice+' '+$('modeNote').textContent;
}
function updateRatios(){const base=physical(500),now=physical(appliedRe);$('ratioContext').textContent=`Re 500と現在のRe ${num(appliedRe)}を比べます。倍率の基準はRe 500です。`;$('ratioU').textContent=num(now.U/base.U,2)+' 倍';$('ratioF').textContent=num(now.f/base.f,2)+' 倍';$('ratioDP').textContent=num(now.dp/base.dp,2)+' 倍';$('ratioUDetail').textContent=`${num(base.U,4)} → ${num(now.U,4)} m/s`;$('ratioFDetail').textContent=`${base.f.toFixed(4)} → ${now.f.toFixed(4)}`;$('ratioDPDetail').textContent=`${num(base.dp,2)} → ${num(now.dp,2)} Pa`;
$('ratioTitle').textContent=appliedRe===1000?'流速2倍・摩擦係数は半分・圧力損失は2倍':'流速を変えると何が変わる？';$('ratioExplanation').textContent=appliedRe===500?'次は「実験2」で実際の平均流速を2倍にしてみましょう。':appliedRe<2300?'層流では流速を上げると摩擦係数は小さくなります。それでも水を流すために必要な圧力差は大きくなります。':appliedRe<4000?'層流と乱流の間にある範囲を遷移域と呼びます。流れの状態は入口の乱れなどにも左右されます。この範囲の摩擦係数は2つの式をつないだ教材用の値です。':'実験結果に基づく乱流の円管の式を使っています。流速が上がると摩擦係数が小さくなっても圧力損失は大きくなります。';}
function bandObservations(){let center=0,nc=0,wall=0,nw=0,side=0;for(const p of engine.particles){const q=Math.hypot(p.y,p.z)/engine.radius;if(q<.25){center+=p.u;nc++}if(q>=.8){wall+=p.u;nw++}side+=p.v*p.v+p.w*p.w}return {center:nc?center/nc:null,wall:nw?wall/nw:null,side:Math.sqrt(side/engine.particles.length)}}
function drawBandArrow(c,x,y,u,label,color){if(u===null)return;const dx=Math.max(-85,Math.min(85,u*38));c.strokeStyle=color;c.fillStyle=color;c.lineWidth=2;c.beginPath();c.moveTo(x,y);c.lineTo(x+dx,y);c.lineTo(x+dx-Math.sign(dx||1)*6,y-4);c.moveTo(x+dx,y);c.lineTo(x+dx-Math.sign(dx||1)*6,y+4);c.stroke();c.font='11px -apple-system,sans-serif';c.textAlign='left';c.fillText(label,x,y-9)}
function updateStats(){const p=physical(appliedRe),f=friction(appliedRe),r=regime(appliedRe);$('statRe').textContent=num(appliedRe);$('statRegime').textContent=labels[r]+(r==='laminar'?'':'の目安');$('statF').textContent=p.f.toFixed(4);$('fFormula').textContent=r==='laminar'?'層流の理論式 fD = 64 / Re':r==='turbulent'?'滑らかな円管の経験式':`遷移域の教材用の値`;$('statU').innerHTML=`${num(p.U,p.U<.1?4:3)}<small>m/s</small>`;$('statDP').innerHTML=`${num(p.dp,p.dp<10?2:1)}<small>Pa</small>`;
$('regimeBadge').textContent=isLaminar()?'軸対称の層流計算':engine.model?'混合のイメージ表示':`指定Re：${labels[r]}の目安`;
$('flowTitle').textContent=isLaminar()?'中心は速い。壁の近くはゆっくり。':engine.model?'色を目印に水の混ざり方を見よう。':'3次元SPHで流れを試す。';
$('flowDesc').textContent=isLaminar()?'半径方向のSPHで求めた速さを表示しています。':engine.model?'渦を起こす力を加えた混合のイメージです。':'この計算には精度の課題が残っています。横の動きだけでは乱流と判断できません。';
$('insightTitle').textContent=isLaminar()?'速さの違う水は隣の水に力を及ぼす。':engine.model?'混合の動きと摩擦係数の求め方を確かめよう。':'横に動く原因には計算誤差もある。';
$('insightText').textContent=isLaminar()?'粘性は速さの違う水同士が力を及ぼし合う性質です。水にも粘性があります。その力が壁まで伝わることで流れに抵抗が生まれます。':engine.model?'ここでは混合を見せるために渦を起こす力を加えています。摩擦係数は円管の式から計算しています。この渦の動きから測った値ではありません。':'この3次元計算では誤差によって横方向の動きが生まれる場合があります。高いReを指定するだけでは自然な乱流を正しく再現できるとは限りません。';
$('profile').setAttribute('aria-label',isLaminar()?'橙の点は半径方向のSPH計算値、線は層流の理論式。':'橙の点は3次元SPHの平均速度、線は円管の理論・経験式。');$('moody').setAttribute('aria-label',`Re ${appliedRe}、円管の式から求めたDarcy摩擦係数 ${p.f.toFixed(4)}。`);updateLesson();updateRatios();}
const palette=Array.from({length:101},(_,i)=>{const stops=[[56,100,171],[37,192,201],[161,228,188],[245,192,114]],v=Math.min(2.999,i/100*3),j=Math.floor(v),t=v-j;return `rgb(${stops[j].map((a,k)=>Math.round(a+(stops[j+1][k]-a)*t)).join(',')})`});
const dyeColors=['#71e1dc','#f5b476','#9ca2f1'];
function renderFlow(){const {c,w,h}=fit($('flow'));c.clearRect(0,0,w,h);const left=29,right=w-29,pw=right-left,cy=h*.57,diam=Math.min(260,h*.53),ry=diam/2,volume=$('view').value==='volume',dye=$('dye').checked,trailsEnabled=$('trails').checked,trailStride=Math.max(1,Math.ceil(engine.particles.length/2500)),particleRadius=Math.max(.7,Math.min(volume?1.5:2,1.9*Math.sqrt(7/resolveQuality(engine.quality).intervals)));
// Soft interior and a fixed wall make the velocity contrast legible.
const fill=c.createLinearGradient(0,cy-ry,0,cy+ry);fill.addColorStop(0,'#1d4351');fill.addColorStop(.5,'#173746');fill.addColorStop(1,'#1d4351');c.fillStyle=fill;c.fillRect(left,cy-ry,pw,diam);
c.save();c.strokeStyle='#254654';c.lineWidth=.6;for(let x=left+20;x<right;x+=35){c.beginPath();c.moveTo(x,cy-ry);c.lineTo(x,cy+ry);c.stroke()}for(let y=cy-ry+20;y<cy+ry;y+=20){c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke()}c.setLineDash([5,7]);c.strokeStyle='#456473';c.beginPath();c.moveTo(left,cy);c.lineTo(right,cy);c.stroke();c.restore();
// Wall strips and hatching are schematic, not measured roughness.
for(const sign of [-1,1]){let y=cy+sign*ry;c.fillStyle='#345260';c.fillRect(left,y+(sign<0?-9:0),pw,9);c.strokeStyle='#819aa4';c.lineWidth=1.2;c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.strokeStyle='#486772';c.lineWidth=.8;for(let x=left;x<right;x+=13){c.beginPath();c.moveTo(x,y+sign*8);c.lineTo(x+7,y+sign*2);c.stroke()}}
c.font='10px -apple-system,sans-serif';c.fillStyle='#7c9ba7';c.textAlign='left';c.fillText('静止した管壁',left,cy-ry-19);c.textAlign='right';c.fillText('流れの向き →',right,cy-ry-19);
const observed=bandObservations();$('centerSpeed').textContent=observed.center===null?'—':observed.center.toFixed(3);$('wallSpeed').textContent=observed.wall===null?'—':observed.wall.toFixed(3);$('sideSpeed').textContent=observed.side.toFixed(3);
if($('guides').checked&&!volume){c.fillStyle='#71e1dc12';c.fillRect(left,cy-ry*.25,pw,ry*.5);c.fillStyle='#f5b47615';c.fillRect(left,cy-ry,pw,ry*.2);c.fillRect(left,cy+ry*.8,pw,ry*.2)}
const ps=engine.particles;let shown=0;for(let i=0;i<ps.length;i++){const p=ps[i],visible=volume||Math.abs(p.z)<.16;const points=histories[i],color=dye?dyeColors[Math.min(2,Math.floor((p.id/ps.length)*3))]:palette[Math.max(0,Math.min(100,Math.round(p.u/2*100)))];if(visible){shown++;const x=left+p.x/6*pw,y=cy-p.y*diam+(volume?p.z*diam*.12:0),alpha=volume?.25+.65*(p.z+.5):.92;c.strokeStyle=color;c.globalAlpha=alpha*.5;c.lineWidth=volume?1:1.3;if(trailsEnabled&&i%trailStride===0&&points&&points.length>1){c.beginPath();let previous=null;for(const a of points){if(!a.visible){previous=null;continue}const px=left+a.x/6*pw,py=cy-a.y*diam+(volume?a.z*diam*.12:0);if(previous===null||Math.abs(px-previous)>pw*.4)c.moveTo(px,py);else c.lineTo(px,py);previous=px}if(points.length&&points.at(-1).visible&&Math.abs(p.x-points.at(-1).x)<3)c.lineTo(x,y);c.stroke()}c.globalAlpha=alpha;c.fillStyle=color;c.beginPath();c.arc(x,y,particleRadius,0,Math.PI*2);c.fill()}}
c.globalAlpha=1;if($('guides').checked&&!volume){drawBandArrow(c,left+pw*.13,cy,observed.center,'中心帯','#71e1dc');drawBandArrow(c,left+pw*.13,cy-ry*.89,observed.wall,'壁寄り','#f5b476')}c.strokeStyle='#698995';c.lineWidth=1;c.beginPath();c.ellipse(right,cy,8,ry,0,-Math.PI/2,Math.PI/2);c.stroke();c.setLineDash([2,4]);c.beginPath();c.ellipse(left,cy,8,ry,0,Math.PI/2,Math.PI*1.5);c.stroke();c.setLineDash([]);c.fillStyle='#7e9ca9';c.font='9px -apple-system,sans-serif';c.textAlign='left';c.fillText('周期境界の局所区間（6D）・円管を模式表示',left,cy+ry+34);c.textAlign='right';if(w>410)c.fillText('右端から左端へ循環 ↻',right,cy+ry+34);$('particleCount').textContent=isLaminar()?`表示 ${num(ps.length)}点 · 断面内 ${num(shown)}点`:`3D計算 ${num(ps.length)}粒子 · 表示 ${num(shown)}粒子`;$('simTime').textContent=`t* = ${engine.time.toFixed(2)}`;$('viewCaption').textContent=(volume?'円管全体を透かして表示。':'管の中心を通る薄い断面を表示。')+(isLaminar()?' 点は流れの目印です。':' 横方向の動きだけで乱流とは判断できません。')+(trailsEnabled&&trailStride>1?' 軌跡の一部を省いて表示しています。':'');$('calculationLabel').textContent=isLaminar()?`計算：半径方向${LAMINAR_RESOLUTIONS[engine.quality]}粒子 ／ 立体表示：${num(ps.length)}点`:`計算：3次元SPH ${num(ps.length)}粒子`;$('sideSpeedLabel').textContent=isLaminar()?'横方向の流れ':'横方向の動き / U';$('sideSpeedNote').textContent=isLaminar()?'横流れゼロを仮定':'横方向の速さを全粒子でまとめた目安';
}
function captureTrails(){if(!$('trails').checked)return;const ps=engine.particles,stride=Math.max(1,Math.ceil(ps.length/2500));for(let i=0;i<ps.length;i+=stride){if(!histories[i])histories[i]=[];const p=ps[i],a=histories[i];a.push({x:p.x,y:p.y,z:p.z,visible:$('view').value==='volume'||Math.abs(p.z)<.16});if(a.length>32)a.shift()}}
function line(c,points,color,width=2,dash=[]){c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.strokeStyle=color;c.lineWidth=width;c.setLineDash(dash);c.stroke();c.setLineDash([])}
function plotBase(canvas,{xLabel,yLabel}){const {c,w,h}=fit(canvas);c.clearRect(0,0,w,h);const box={c,w,h,l:47,t:23,r:w-17,b:h-43};c.font='10px -apple-system,sans-serif';c.fillStyle=colors.muted;c.textAlign='left';c.fillText(yLabel,box.l,12);c.textAlign='right';c.fillText(xLabel,box.r,h-5);return box}
function drawMoody(){const b=plotBase($('moody'),{xLabel:'レイノルズ数 Re →（対数）',yLabel:'Darcy 管摩擦係数 f_D（対数）'}),{c,l,t,r,b:bottom,w}=b;const X=re=>l+(Math.log10(re)-2)/3*(r-l),Y=f=>bottom-(Math.log10(f)-Math.log10(.006))/(Math.log10(1)-Math.log10(.006))*(bottom-t);c.fillStyle='#eef0f0';c.fillRect(X(2300),t,X(4000)-X(2300),bottom-t);c.fillStyle='#89979c';c.textAlign='center';c.font='9px -apple-system,sans-serif';c.fillText('遷移',X(3100),t+13);
for(const v of [.01,.02,.05,.1,.2,.5,1]){const y=Y(v);line(c,[[l,y],[r,y]],colors.grid,.8);c.fillStyle=colors.muted;c.textAlign='right';c.fillText(String(v),l-8,y+3)}for(const v of [100,1000,10000,100000]){const x=X(v);line(c,[[x,t],[x,bottom]],colors.grid,.8);c.fillStyle=colors.muted;c.textAlign=v===100000?'right':v===100?'left':'center';c.fillText(v===100000?'10⁵':v===10000?'10⁴':v===1000?'10³':'10²',x,bottom+18)}
const curve=(a,z,fn,n=90)=>Array.from({length:n},(_,i)=>{const re=a*(z/a)**(i/(n-1));return [X(re),Y(fn(re))]});line(c,curve(100,2300,re=>64/re),colors.teal,2.3);line(c,curve(2300,4000,re=>friction(re).value),colors.muted,1.7,[4,4]);line(c,curve(4000,100000,re=>friction(re).value),colors.navy,2.3);
for(const a of records){c.beginPath();c.arc(X(a.re),Y(a.f),4,0,Math.PI*2);c.fillStyle='#fff';c.fill();c.strokeStyle=colors.orange;c.lineWidth=1.5;c.stroke()}
const x=X(appliedRe),y=Y(friction(appliedRe).value);line(c,[[x,t+18],[x,bottom]],'#c6d3d5',1,[3,4]);c.fillStyle='#fff';c.beginPath();c.arc(x,y,7,0,Math.PI*2);c.fill();c.fillStyle=colors.orange;c.beginPath();c.arc(x,y,4.5,0,Math.PI*2);c.fill();const txt=`${friction(appliedRe).value.toFixed(4)}`,tw=c.measureText(txt).width+14,tx=Math.min(r-tw,Math.max(l,x+10)),ty=Math.min(bottom-15,Math.max(t+23,y-13));c.fillStyle='#fdf0e4';c.fillRect(tx-3,ty-12,tw,20);c.fillStyle='#a96632';c.textAlign='left';c.font='10px ui-monospace,monospace';c.fillText(txt,tx+3,ty+1);
}
function collectProfile(){if(isLaminar()){profileBins=engine.sample().map(a=>({r:a.r,u:a.u,n:1}));return}const binCount=Math.max(7,resolveQuality(engine.quality).intervals);const bins=Array.from({length:binCount},()=>({n:0,sum:0,r:0}));for(const p of engine.particles){const rad=Math.hypot(p.y,p.z)/.5,j=Math.min(binCount-1,Math.floor(rad*binCount));bins[j].n++;bins[j].sum+=p.u;bins[j].r+=rad}profileBins=bins.filter(a=>a.n).map(a=>({r:a.r/a.n,u:a.sum/a.n,n:a.n}))}
function drawProfile(){const {c,l,t,r,b}=plotBase($('profile'),{xLabel:'軸方向速度 u/U →',yLabel:'中心からの距離 r/R'});const xmax=2.3,X=u=>l+u/xmax*(r-l),Y=rad=>b-rad*(b-t);for(const v of [0,.5,1,1.5,2]){line(c,[[X(v),t],[X(v),b]],colors.grid,.8);c.fillStyle=colors.muted;c.textAlign='center';c.fillText(String(v),X(v),b+18)}for(const v of [0,.5,1]){line(c,[[l,Y(v)],[r,Y(v)]],colors.grid,.8);c.fillStyle=colors.muted;c.textAlign='right';c.fillText(v===0?'0 中心':v===1?'1 壁':'0.5',l-5,Y(v)+3)}line(c,[[X(1),t],[X(1),b]],'#b6c6c9',1,[3,5]);if(appliedRe>=2300)line(c,Array.from({length:100},(_,i)=>{const rad=i/99;return[X(normalizedProfile(rad,1000)),Y(rad)]}),'#a0b2ba',1.4,[4,4]);line(c,Array.from({length:100},(_,i)=>{const rad=i/99;return[X(normalizedProfile(rad,appliedRe)),Y(rad)]}),colors.navy,2);$('profileReferenceLabel').textContent=engine.model?'モデルに与えた速度分布':appliedRe<2300?'層流の理論式':'円管の経験式';
for(const a of profileBins){const x=X(a.u);if(x<l||x>r)continue;c.beginPath();c.arc(x,Y(a.r),3.5,0,Math.PI*2);c.fillStyle=colors.orange;c.fill()}c.font='9px -apple-system,sans-serif';c.textAlign='left';c.fillStyle=colors.muted;c.fillText('U：参照の平均速度',X(1)+5,t+13);
}
function drawCharts(){collectProfile();drawMoody();drawProfile()}
function updateAccuracy(){accuracyState=laminarAccuracy(engine,diagnostics);const a=accuracyState;$('accuracyNote').classList.toggle('accuracy-alert',a.exceeded);$('accuracyContinue').hidden=!a.exceeded||accuracyOverride;
if(!a.assessed){$('accuracyState').textContent='この条件では層流の理論式との精度比較を行いません。';$('accuracyDetails').textContent=engine.model?'混合のイメージを示すモデルを使っています。':'Re 2,300以上の流れは層流の理論式だけでは評価できません。';return}
const percent=(a.relativeL2*100).toFixed(isLaminar()?3:1),metrics=isLaminar()?`計算に使う${diagnostics.computationalParticleCount}粒子で比較しています。横流れゼロは層流の仮定です。`:`横速度RMS/U ${a.transverseRMS.toFixed(3)}・最大密度偏差 ${(a.densityError*100).toFixed(1)}%。`;
if(a.exceeded){if(!accuracyOverride&&running)setRunning(false);$('accuracyState').textContent=accuracyOverride?'理論式との差が大きい状態で観察を続けています。':'理論式との差が大きくなったため計算を一時停止しました。';$('accuracyDetails').textContent=`速度分布の誤差 ${percent}%。`+metrics+' これは乱流へ移ったという判定ではありません。'}else{$('accuracyState').textContent=`層流の理論式との違い：${percent}％`;$('accuracyDetails').textContent=metrics}
}
$('accuracyContinue').addEventListener('click',()=>{accuracyOverride=true;setRunning(true);updateDiagnostics()});
function updateDiagnostics(){diagnostics=engine.diagnostics();updateAccuracy();learningTools.updateWall(diagnostics,accuracyState);const d=diagnostics;$('diagnostics').textContent=isLaminar()?`軸対称SPH：計算${d.computationalParticleCount}粒子／表示${num(d.displayParticleCount)}点。断面平均速度u/U=${d.areaMeanU.toFixed(4)} ／ 理論式との相対L2差=${(d.radialRelativeL2*100).toFixed(4)}% ／ t*=${d.time.toFixed(2)}。一定の圧力差による力と粘性を計算します。密度や圧力波の変化は解きません。`:`3次元SPH：${num(d.count)}粒子。平均速度u/U=${d.particleMeanU.toFixed(3)} ／ 横速度RMS/U=${d.rmsTransverse.toFixed(3)} ／ 最大密度偏差=${(d.densityError*100).toFixed(1)}% ／ 人工粘性α=${d.artificialViscosityAlpha.toFixed(3)} ／ t*=${d.time.toFixed(2)}。`;
$('performance').textContent=`計算 ${stepCostMs.toFixed(0)} ms/更新 · 時間の進み ${simulationRate.toFixed(2)} t*/秒`+(isLaminar()?'':engine.particles.length>5000?' · 重い場合は粒子数を減らしてください。':'');if(!d.stable)throw new Error('計算の値が不安定になりました。「初めから」で再計算してください。')}
function drawRecords(){const el=$('records');el.replaceChildren();for(const a of records){const node=document.createElement('div');node.className='record-chip';const bold=document.createElement('b');bold.textContent=`Re ${num(a.re)} · ${labels[regime(a.re)]}`;node.append(bold,document.createTextNode(`f = ${a.f.toFixed(4)} / Δp = ${num(a.dp,2)} Pa`));el.append(node)}$('recordActions').hidden=!records.length;drawMoody()}
$('record').addEventListener('click',()=>{if(records.some(a=>a.re===appliedRe))return;records.push({re:appliedRe,...physical(appliedRe)});if(records.length>6)records.shift();persistRecords();drawRecords()});$('clearRecords').addEventListener('click',()=>{records=[];persistRecords();drawRecords()});
function saveFile(content,type,name){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
$('csv').addEventListener('click',()=>{const rows=[['Re','regime','Darcy_f_reference','U_m_s','dp_Pa_reference','wall_stress_Pa_reference','Q_m3_s','pumping_power_W','note'],...records.map(a=>[a.re,regime(a.re),a.f,a.U,a.dp,a.tau,a.Q,a.power,regime(a.re)==='transition'?'illustrative interpolation; not SPH measurement':'circular-pipe reference; not SPH measurement'])];saveFile('\uFEFF'+rows.map(a=>a.join(',')).join('\r\n'),'text/csv;charset=utf-8','pipe-flow-comparison.csv')});
$('download').addEventListener('click',()=>{const a=document.createElement('a');a.href='downloads/ReynoldsFlowLab_v3.2.0.zip';a.download='ReynoldsFlowLab_v3.2.0.zip';a.click()});

function experimentStatus(message,error=false){
  const node=document.querySelector('#experimentStatus');
  if(node){node.textContent=message;node.classList.toggle('is-error',error)}
}
function experimentBusy(value){
  experimentReading=value;
  for(const id of ['saveExperiment','loadExperiment']){
    const button=document.querySelector('#'+id);if(button)button.disabled=value;
  }
}
function cancelExperimentRead(){const reading=experimentReading;experimentLoadToken++;experimentBusy(false);if(reading)experimentStatus('読み込みを中止し、選んだ条件で実験します。')}
function persistRecords(){
  try{window.localStorage.setItem(RECORD_CACHE,JSON.stringify(records.map(row=>row.re)))}catch(_){}
}
function restoreRecords(){
  try{
    const text=window.localStorage.getItem(RECORD_CACHE);
    if(text===null)return [];
    if(text.length>MAX_JSON_CHARACTERS)return [];
    return normaliseRecords(JSON.parse(text)).map(re=>({re,...physical(re)}));
  }catch(_){return []}
}
function currentExperiment(){
  return {re:appliedRe,mode:activeMode,quality:engine.quality,alpha:engine.artificialViscosityAlpha,
    lesson:lessonId,view:$('view').value,speed:Number($('speed').value),
    trails:$('trails').checked,dye:$('dye').checked,guides:$('guides').checked};
}
function applySavedExperiment(saved,next){
  const settings=saved.settings;
  engine=next;activeMode=settings.mode;appliedRe=settings.re;pendingRe=settings.re;
  lessonId=settings.lesson;modeNotice='';
  $('mode').value=settings.mode;$('quality').value=settings.quality;$('alpha').value=String(settings.alpha);
  $('view').value=settings.view;$('speed').value=String(settings.speed);
  for(const id of ['trails','dye','guides'])$(id).checked=settings[id];
  $('lessonAnswer').open=false;records=saved.records.map(re=>({re,...physical(re)}));
  clearProgress();qualityHelp();setRunning(false);updateDyeLegend();updateStats();
  drawCharts();drawRecords();renderFlow();updateDiagnostics();persistRecords();
}
function setupExperimentActions(){
  document.querySelector('#saveExperiment')?.addEventListener('click',()=>{
    try{
      const text=exportExperiment(currentExperiment(),records.map(row=>row.re));
      saveFile(text,'application/json;charset=utf-8',`flow-experiment-Re${appliedRe}.json`);
      experimentStatus('実験条件と比較記録をJSONに保存しました。');
    }catch(_){experimentStatus('保存できませんでした。実験条件を確認してください。',true)}
  });
  const input=document.querySelector('#experimentFile');
  document.querySelector('#loadExperiment')?.addEventListener('click',()=>input?.click());
  input?.addEventListener('change',async()=>{
    const file=input.files?.[0];input.value='';if(!file)return;
    const token=++experimentLoadToken;experimentBusy(true);experimentStatus('実験ファイルを読み込んでいます…');
    try{
      if(!Number.isFinite(file.size)||file.size>MAX_JSON_CHARACTERS)throw new Error('このアプリで保存した実験JSONを選んでください。');
      const text=await file.text();if(token!==experimentLoadToken)return;
      const saved=readExperiment(text),settings=saved.settings;
      const next=makeEngine(settings.re,settings.quality,settings.mode,settings.alpha);
      if(token!==experimentLoadToken)return;
      applySavedExperiment(saved,next);
      experimentStatus('実験条件と比較記録を読み込みました。「再開」で初めから計算できます。');
    }catch(error){if(token===experimentLoadToken)experimentStatus(error.message,true)}
    finally{if(token===experimentLoadToken)experimentBusy(false)}
  });
  const figureButton=document.querySelector('#saveFigure');
  figureButton?.addEventListener('click',()=>{
    const re=appliedRe,mode=activeMode;figureButton.disabled=true;experimentStatus('流れの図をPNGにしています…');
    try{
      $('flow').toBlob(blob=>{
        figureButton.disabled=false;
        if(!blob){experimentStatus('PNGを保存できませんでした。もう一度お試しください。',true);return}
        saveFile(blob,'image/png',`pipe-flow-${mode}-Re${re}.png`);
        experimentStatus('流れの図をPNGに保存しました。');
      },'image/png');
    }catch(_){figureButton.disabled=false;experimentStatus('PNGを保存できませんでした。もう一度お試しください。',true)}
  });
}
setupExperimentActions();
window.addEventListener('resize',()=>{renderFlow();drawCharts()});document.addEventListener('visibilitychange',()=>{last=0});
function animate(now){try{const elapsed=last?Math.min(32,now-last):16.67;last=now;if(running&&!document.hidden){const start=performance.now();const loadScale=!isLaminar()&&stepCostMs>22?Math.max(.25,22/stepCostMs):1;const requestedStep=.0056*(elapsed/16.67)*Number($('speed').value)*loadScale;const workLimit=!isLaminar()&&engine.particles.length>5000?engine.diagnostics().maxTimeStep*.9:Infinity;engine.step(Math.min(requestedStep,workLimit));const cost=performance.now()-start;stepCostMs=stepCostMs?stepCostMs*.8+cost*.2:cost;if(frame%2===0)captureTrails()}renderFlow();if(frame%12===0){collectProfile();drawProfile();if(lastRateTime&&now>lastRateTime)simulationRate=(engine.time-lastRateSim)/((now-lastRateTime)/1000);lastRateTime=now;lastRateSim=engine.time;updateDiagnostics()}frame++}catch(e){setRunning(false);$('error').hidden=false;$('error').textContent=e.message;console.error(e)}requestAnimationFrame(animate)}
records=restoreRecords();qualityHelp();setRunning(running);updateStats();drawCharts();drawRecords();renderFlow();updateDiagnostics();requestAnimationFrame(animate);
