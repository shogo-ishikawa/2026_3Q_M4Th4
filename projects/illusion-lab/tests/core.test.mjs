import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOGUE,makeScene,makeQuiz,normaliseSeed} from '../web/core.js';

const levels=['easy','standard','hard'];
const eligible=CATALOGUE.filter(item=>item.quiz);
const sizeIds=['muller-lyer','ponzo','ebbinghaus','delboeuf','vertical-horizontal','jastrow','oppel-kundt'];
const directionIds=['zollner','cafe-wall','hering','wundt'];
const signAnswer=(a,b)=>a===b?'same':a>b?'a':'b';
function assertFiniteTree(value) {
  if(typeof value==='number') assert.ok(Number.isFinite(value));
  else if(value&&typeof value==='object') for(const child of Object.values(value)) assertFiniteTree(child);
}

test('18種類に説明と一意のIDがあり15種類を出題できる',()=>{
  assert.equal(CATALOGUE.length,18);assert.equal(new Set(CATALOGUE.map(x=>x.id)).size,18);assert.equal(eligible.length,15);
  for(const item of CATALOGUE) {
    assert.ok(item.name&&item.summary&&item.principle);
    assert.ok(['length','size','direction','brightness','shape'].includes(item.category));
  }
});

test('数値と文字列のシードを安定した整数へ変換する',()=>{
  assert.equal(normaliseSeed(0),0);assert.equal(normaliseSeed('0'),0);assert.equal(normaliseSeed(' 42 '),42);
  assert.equal(normaliseSeed('夜の実験'),normaliseSeed('夜の実験'));assert.notEqual(normaliseSeed('夜の実験'),normaliseSeed('朝の実験'));
  assert.equal(normaliseSeed(''),1);assert.equal(normaliseSeed(0xffffffff),0xffffffff);
  for(const value of [-1,1.5,NaN,Infinity,4294967296,'999999999999999999999',null,{},'x'.repeat(81)]) assert.throws(()=>normaliseSeed(value));
});

test('全種類・全難易度で有限の図形と対応する選択肢を作る',()=>{
  for(const {id} of CATALOGUE) for(const difficulty of levels) for(const seed of [0,1,42,987,0xffffffff]) {
    const scene=makeScene(id,{seed,difficulty,truthMode:'random'});
    assertFiniteTree(scene);assert.ok(scene.choices.some(c=>c.id===scene.answer));
    assert.ok(scene.question&&scene.answerText&&scene.explanation);assert.ok(scene.measurements.length);
    assert.equal(scene.seed,seed);assert.equal(new Set(scene.choices.map(c=>c.id)).size,scene.choices.length);
  }
});

test('同じシードと設定なら図形と出題順が再現する',()=>{
  for(const {id} of CATALOGUE) assert.deepEqual(makeScene(id,{seed:'教室A'}),makeScene(id,{seed:'教室A'}));
  const options={seed:127,difficulty:'hard',count:30};
  assert.deepEqual(makeQuiz(options),makeQuiz(options));
  assert.notDeepEqual(makeQuiz(options),makeQuiz({...options,seed:128}));
});

test('実験室の長さと大きさは等しくランダム問題には実際の大小も混ざる',()=>{
  for(const id of sizeIds) for(const difficulty of levels) {
    const equal=makeScene(id,{seed:9,difficulty});assert.equal(equal.a,equal.b);assert.equal(equal.answer,'same');
    const answers=new Set();
    for(let seed=0;seed<150;seed++) {
      const s=makeScene(id,{seed,difficulty,truthMode:'random'});
      assert.equal(s.answer,signAnswer(s.a,s.b));assert.ok(s.a>0&&s.b>0);answers.add(s.answer);
    }
    assert.deepEqual([...answers].sort(),['a','b','same']);
  }
});

test('平行の正答は二つの直線の角度で決まる',()=>{
  for(const id of directionIds) for(const difficulty of levels) {
    const answers=new Set();
    for(let seed=0;seed<100;seed++) {
      const s=makeScene(id,{seed,difficulty,truthMode:'random'});
      assert.equal(s.answer,s.a===s.b?'same':'different');answers.add(s.answer);
      assert.equal(s.measurements[0].value,s.a);assert.equal(s.measurements[1].value,s.b);
    }
    assert.deepEqual([...answers].sort(),['different','same']);
  }
});

test('ポッゲンドルフの正解候補だけが基準線と同一直線上にある',()=>{
  const found=new Set();
  for(const difficulty of levels) for(let seed=0;seed<180;seed++) {
    const scene=makeScene('poggendorff',{seed,difficulty,truthMode:'random'});
    const {left,rightA,rightB}=scene.params;
    const cross=p=>(left.x2-left.x1)*(p.y1-left.y1)-(left.y2-left.y1)*(p.x1-left.x1);
    const ca=Math.abs(cross(rightA)),cb=Math.abs(cross(rightB));
    assert.ok(Math.min(ca,cb)<1e-8);assert.ok(Math.max(ca,cb)>1000);
    assert.equal(scene.answer,ca<cb?'a':'b');found.add(scene.answer);
    for(const right of [rightA,rightB]) {
      assert.ok(Math.abs((right.y2-right.y1)/(right.x2-right.x1)-(left.y2-left.y1)/(left.x2-left.x1))<1e-10);
      assert.ok(right.y1>0&&right.y1<600&&right.y2>0&&right.y2<600);
    }
  }
  assert.deepEqual([...found].sort(),['a','b']);
});

test('中央の円と周辺の円や外側の輪が重ならない',()=>{
  for(const difficulty of levels) for(let seed=0;seed<100;seed++) {
    const e=makeScene('ebbinghaus',{seed,difficulty,truthMode:'random'});
    for(const suffix of ['A','B']) {
      const radius=e[suffix.toLowerCase()]/2,surround=e.params[`surround${suffix}`],orbit=e.params[`orbit${suffix}`],count=e.params[`count${suffix}`];
      assert.ok(orbit>radius+surround+15);assert.ok(2*orbit*Math.sin(Math.PI/count)>2*surround);
      assert.ok(orbit+surround<250);
    }
    const d=makeScene('delboeuf',{seed,difficulty,truthMode:'random'});
    assert.ok(d.params.ringA>d.a/2+10);assert.ok(d.params.ringB>d.b/2+10);
  }
});

test('ジャストローの面積比較は同じ角度と内外半径比を使う',()=>{
  for(let seed=0;seed<120;seed++) {
    const s=makeScene('jastrow',{seed,truthMode:'random'}),{innerRatio,spanDeg}=s.params;
    const area=diameter=>Math.PI*(diameter/2)**2*(1-innerRatio**2)*spanDeg/360;
    assert.ok(innerRatio>0&&innerRatio<1&&spanDeg>0&&spanDeg<180);
    assert.equal(s.answer,signAnswer(area(s.a),area(s.b)));
  }
});

test('グレーと色の正答は指定RGBから決まり値が範囲を超えない',()=>{
  for(const difficulty of levels) for(let seed=0;seed<150;seed++) {
    for(const id of ['simultaneous-brightness','white']) {
      const s=makeScene(id,{seed,difficulty,truthMode:'random'});
      assert.equal(s.answer,signAnswer(s.a,s.b));assert.ok(s.a>=0&&s.a<=255&&s.b>=0&&s.b<=255);
    }
    const s=makeScene('colour-contrast',{seed,difficulty,truthMode:'random'});
    const same=s.params.colourA.every((value,i)=>value===s.params.colourB[i]);
    assert.equal(s.answer,same?'same':'different');
    for(const colour of [s.params.colourA,s.params.colourB]) assert.ok(colour.every(v=>Number.isInteger(v)&&v>=0&&v<=255));
  }
});

test('展示用の格子・三角形・同心円は検証可能な構成を持つ',()=>{
  const grid=makeScene('hermann');assert.equal(grid.params.dotCount,0);
  const triangle=makeScene('kanizsa');assert.equal(triangle.params.vertices.length,3);assert.equal(triangle.measurements[0].value,0);
  const rings=makeScene('fraser');assert.equal(new Set(rings.params.radii).size,rings.params.radii.length);assert.ok(rings.params.radii.every(r=>r>0&&r<300));
});

test('三角形と同心円も別のシードで誘導模様が変わる',()=>{
  for(const difficulty of levels) {
    const triangles=Array.from({length:24},(_,seed)=>makeScene('kanizsa',{seed,difficulty}));
    const rings=Array.from({length:24},(_,seed)=>makeScene('fraser',{seed,difficulty}));
    assert.ok(new Set(triangles.map(scene=>scene.params.inducerRadius)).size>20);
    assert.ok(new Set(rings.map(scene=>scene.params.tilt)).size>20);
    assert.ok(new Set(rings.map(scene=>scene.params.segments)).size>1);
    for(const scene of triangles) {
      assert.ok(scene.params.inducerRadius>50&&scene.params.inducerRadius<85);
      assert.equal(scene.answer,'absent');assert.equal(scene.measurements[0].value,0);
    }
    for(const scene of rings) {
      assert.deepEqual(scene.params.radii,[38,72,106,140,174,208,242]);
      assert.equal(scene.answer,'circles');assert.equal(scene.measurements[0].value,7);
    }
  }
});

test('難易度を上げると実際の差が小さくなる',()=>{
  for(const id of ['muller-lyer','ebbinghaus','simultaneous-brightness','zollner','poggendorff']) {
    for(let seed=0;seed<50;seed++) {
      const differences=levels.map(difficulty=>{const s=makeScene(id,{seed,difficulty,truthMode:'random'});return Math.abs(s.a-s.b);});
      if(differences[0]) assert.ok(differences[0]>differences[1]&&differences[1]>differences[2]);
    }
  }
});

test('選んだ種類だけをシャッフルして一巡するまで重複させない',()=>{
  const ids=['muller-lyer','ponzo','ebbinghaus'];
  for(let seed=0;seed<30;seed++) {
    const scenes=makeQuiz({seed,count:30,ids});assert.equal(scenes.length,30);
    for(let i=0;i<30;i+=3) assert.equal(new Set(scenes.slice(i,i+3).map(s=>s.id)).size,3);
    for(let i=1;i<scenes.length;i++) assert.notEqual(scenes[i].id,scenes[i-1].id);
  }
  assert.equal(makeQuiz({ids:['ponzo'],count:5}).length,5);
});

test('無効な種類・難易度・出題数・出題範囲を拒否する',()=>{
  for(const invoke of [()=>makeScene('unknown'),()=>makeScene('ponzo',{difficulty:'unknown'}),()=>makeScene('ponzo',{truthMode:'truth'}),
    ()=>makeQuiz({count:0}),()=>makeQuiz({count:31}),()=>makeQuiz({count:2.5}),()=>makeQuiz({ids:[]}),()=>makeQuiz({ids:['hermann']}),
    ()=>makeQuiz({ids:['unknown']}),()=>makeQuiz({ids:'ponzo'}),()=>makeQuiz({difficulty:'unknown'})]) assert.throws(invoke);
});
