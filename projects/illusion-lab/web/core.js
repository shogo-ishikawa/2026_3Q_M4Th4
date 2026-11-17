/** Exact figure values shared by the generator, quiz and visual proofs. */
export const CATALOGUE = Object.freeze([
  {id:'muller-lyer', name:'ミュラー・リヤー錯視', category:'length', summary:'矢羽根を変えると線の長さはどう見える？', principle:'線の端に付く矢羽根が長さの見積もりに影響することがあります。中央の線そのものを比べます。', quiz:true},
  {id:'ponzo', name:'ポンゾ錯視', category:'length', summary:'奥へ続く道の上で長さを比べる。', principle:'収束する線は奥行きを感じさせます。横線の見かけの長さと図に描かれた長さを比べます。', quiz:true},
  {id:'hermann', name:'ヘルマン格子錯視', category:'shape', summary:'白い交差点に灰色の点はある？', principle:'黒い区画の間の白い交差点に灰色の点が見えることがあります。この図では灰色の点を描いていません。', quiz:false},
  {id:'zollner', name:'ツェルナー錯視', category:'direction', summary:'短い斜線に囲まれた基準線を調べる。', principle:'交差する短線の向きによって基準線の方向が違って見えることがあります。AとBの角度を比べます。', quiz:true},
  {id:'ebbinghaus', name:'エビングハウス錯視', category:'size', summary:'周りの円が変わると中央の円も変わる？', principle:'周囲の円の大きさや配置が中央の円の見え方に影響します。比べるのは色の付いた中央の円です。', quiz:true},
  {id:'delboeuf', name:'デルブーフ錯視', category:'size', summary:'外側の輪と中央の円の関係を見る。', principle:'外側の輪と中央の円の間隔によって大きさの印象が変わることがあります。外側の輪を隠して中央の円を比べます。', quiz:true},
  {id:'cafe-wall', name:'カフェウォール錯視', category:'direction', summary:'ずれたタイルの間の線は平行？', principle:'明暗のタイルをずらすと境界の線が傾いて見えることがあります。AとBの基準線の角度で確かめます。', quiz:true},
  {id:'poggendorff', name:'ポッゲンドルフ錯視', category:'direction', summary:'帯に隠れた斜線はどちらにつながる？', principle:'途中を帯で隠すと斜線のつながりを見誤ることがあります。左の基準線をそのまま延ばして調べます。', quiz:true},
  {id:'kanizsa', name:'カニッツァの三角形', category:'shape', summary:'辺を描かずに三角形が見える？', principle:'切り欠きのある円の配置から三角形の輪郭を感じることがあります。この図では三角形の辺を結ぶ線を描いていません。', quiz:false},
  {id:'fraser', name:'フレーザー錯視', category:'shape', summary:'渦巻きに見える輪の正体を調べる。', principle:'斜めの模様を並べると同心円が渦巻きのように見えることがあります。模様を隠して中心と半径を確認します。', quiz:false},
  {id:'hering', name:'ヘリング錯視', category:'direction', summary:'放射線の上でまっすぐな線を比べる。', principle:'放射状の背景が線の形や方向の印象に影響することがあります。背景を消して基準線を確かめます。', quiz:true},
  {id:'wundt', name:'ヴント錯視', category:'direction', summary:'扇状の背景と基準線の関係を見る。', principle:'扇状に広がる背景によって基準線が曲がったように見えることがあります。線そのものは直線で描きます。', quiz:true},
  {id:'vertical-horizontal', name:'垂直・水平錯視', category:'length', summary:'縦と横では同じ長さが違って見える？', principle:'線の向きや配置が長さの印象に影響することがあります。向きをそろえて重ねると比べやすくなります。', quiz:true},
  {id:'jastrow', name:'ジャストロー錯視', category:'size', summary:'同じ形の帯をずらして並べる。', principle:'弧の長い側と短い側が隣り合う配置では大きさが違って見えることがあります。角度と内外半径の比をそろえた二つの形を比べます。', quiz:true},
  {id:'simultaneous-brightness', name:'明るさの同時対比', category:'brightness', summary:'背景だけで中央のグレーが変わって見える。', principle:'周囲が暗い場合と明るい場合では同じグレーでも見え方が変わることがあります。中央に指定したRGB値を確かめます。', quiz:true},
  {id:'white', name:'ホワイト錯視', category:'brightness', summary:'縞の上のグレーを比べる。', principle:'黒白の縞と灰色の領域が接する配置で明るさの印象が変わることがあります。灰色の領域に指定したRGB値を比べます。', quiz:true},
  {id:'colour-contrast', name:'色の同時対比', category:'brightness', summary:'周囲の色を変えて中央の色を見る。', principle:'周囲の色によって中央の色の印象が変わることがあります。答え合わせでは中央の二つに指定したRGB値を比べます。', quiz:true},
  {id:'oppel-kundt', name:'オッペル・クント錯視', category:'length', summary:'区切った長さと区切らない長さを比べる。', principle:'区間を短い線で分けると長さの印象が変わることがあります。端から端までの長さに注目します。', quiz:true}
].map(Object.freeze));

const BY_ID = new Map(CATALOGUE.map(item => [item.id,item]));
const LEVELS = Object.freeze({easy:{strength:.35,ratio:.16,angle:8,grey:36,offset:56},standard:{strength:.65,ratio:.085,angle:4,grey:20,offset:34},hard:{strength:1,ratio:.035,angle:1.8,grey:9,offset:17}});
const LENGTH_IDS = new Set(['muller-lyer','ponzo','vertical-horizontal','oppel-kundt']);
const SIZE_IDS = new Set(['ebbinghaus','delboeuf','jastrow']);
const PARALLEL_IDS = new Set(['zollner','cafe-wall','hering','wundt']);
const GREY_IDS = new Set(['simultaneous-brightness','white']);
const round = (value, digits=3) => Number(value.toFixed(digits));

/** A seed is reproducible across browsers; zero is a valid seed. */
export function normaliseSeed(value=1) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('シードは0〜4294967295の整数にしてください。');
    return value >>> 0;
  }
  if (typeof value !== 'string') throw new TypeError('シードには数値か文字列を使ってください。');
  const text = value.trim();
  if (!text) return 1;
  if (text.length > 80) throw new RangeError('シードは80文字以内にしてください。');
  if (/^\d+$/.test(text)) return normaliseSeed(Number(text));
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash,16777619);
  }
  return hash >>> 0;
}

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15),state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7),n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function levelSettings(difficulty) {
  if (!Object.hasOwn(LEVELS,difficulty)) throw new RangeError('難易度はeasy・standard・hardから選んでください。');
  return LEVELS[difficulty];
}

function compared(a,b) { return a===b?'same':a>b?'a':'b'; }
function displayNumber(value) { return Number.isInteger(value)?String(value):String(round(value,2)); }
function ternaryChoices(word) {
  return [{id:'a',label:`Aの方が${word}`},{id:'same',label:'同じ'},{id:'b',label:`Bの方が${word}`}];
}
function answerFor(choices,answer) { return choices.find(choice=>choice.id===answer).label; }

/** All numbers below are figure coordinates, angles or specified RGB values. */
export function makeScene(id,{seed=1,difficulty='standard',truthMode='equal'}={}) {
  const item = BY_ID.get(id);
  if (!item) throw new RangeError('錯視の種類を選んでください。');
  const level = levelSettings(difficulty);
  if (!['equal','random'].includes(truthMode)) throw new RangeError('図形の生成方法が正しくありません。');
  seed = normaliseSeed(seed);
  const random = generator(seed);
  const between = (lo,hi) => lo+(hi-lo)*random();
  const flip = random() < .5;
  const params = {strength:level.strength,flip,wingLength:round(between(35,49)+level.strength*39),wingAngle:round(between(25,55)),spacing:round(between(28,48))};
  const scene = {id,seed,difficulty,a:0,b:0,params,answer:'same',choices:[],question:'',answerText:'',explanation:'',measurements:[]};
  const pairKind = truthMode==='equal'?'same':['same','a','b'][Math.floor(random()*3)];

  if (LENGTH_IDS.has(id) || SIZE_IDS.has(id)) {
    const base = id==='ponzo'?between(210,250):id==='jastrow'?between(330,365):SIZE_IDS.has(id)?between(76,96):between(250,325);
    scene.a = round(base,1);
    scene.b = pairKind==='same'?scene.a:round(base*(pairKind==='a'?1-level.ratio:1+level.ratio),1);
    scene.answer = compared(scene.a,scene.b);
    const size = SIZE_IDS.has(id);
    scene.choices = ternaryChoices(size?'大きい':'長い');
    scene.question = size?'色の付いた図形AとBはどちらが大きいですか？':'線AとBはどちらが長いですか？';
    const quantity = id==='jastrow'?'外径':size?'直径':'長さ';
    scene.measurements = [{label:`Aの${quantity}`,value:scene.a,unit:'図の単位'},{label:`Bの${quantity}`,value:scene.b,unit:'図の単位'}];
    if (id==='muller-lyer') params.inwardFirst = flip;
    if (id==='ponzo') Object.assign(params,{railTop:round(between(145,170)),railBottom:round(between(330,380)),railCount:Math.round(6+level.strength*7)});
    if (id==='vertical-horizontal') params.joined = flip;
    if (id==='oppel-kundt') params.divisions = Math.round(7+level.strength*9+between(0,3));
    if (id==='ebbinghaus') {
      const bigR = round(45+level.strength*11),smallR=round(15+level.strength*5),targetR=Math.max(scene.a,scene.b)/2;
      Object.assign(params,{surroundA:flip?bigR:smallR,surroundB:flip?smallR:bigR,countA:flip?6:8,countB:flip?8:6,
        orbitA:round(targetR+(flip?bigR:smallR)+18),orbitB:round(targetR+(flip?smallR:bigR)+18)});
    }
    if (id==='delboeuf') {
      const tight = 12+level.strength*4,wide=54+level.strength*24;
      Object.assign(params,{ringA:round(scene.a/2+(flip?tight:wide)),ringB:round(scene.b/2+(flip?wide:tight))});
    }
    if (id==='jastrow') Object.assign(params,{innerRatio:.64,spanDeg:105,shift:round(20+level.strength*16)});
  } else if (PARALLEL_IDS.has(id)) {
    const vertical = id==='hering'||id==='wundt';
    scene.a = vertical?90:id==='cafe-wall'?0:[-4,0,4][Math.floor(random()*3)];
    const unequal = truthMode==='random' && random()<.5;
    scene.b = unequal?round(scene.a+(flip?1:-1)*level.angle):scene.a;
    scene.answer = scene.a===scene.b?'same':'different';
    scene.choices = [{id:'same',label:'平行に描かれている'},{id:'different',label:'傾きが違う'}];
    scene.question = '基準線AとBは平行に描かれていますか？';
    scene.measurements = [{label:'Aの角度',value:scene.a,unit:'°'},{label:'Bの角度',value:scene.b,unit:'°'}];
    Object.assign(params,{lineLength:vertical?365:610,hatchAngle:round(30+level.strength*25),rayCount:Math.round(14+level.strength*12),tileWidth:round(between(58,78)),tileHeight:38,mortar:6});
  } else if (id==='poggendorff') {
    const slope = round((flip?1:-1)*between(.38,.50));
    const expectedY = 300+slope*200;
    const alignA = random()<.5;
    const displacement = (random()<.5?-1:1)*level.offset;
    const yA = alignA?expectedY:expectedY+displacement;
    const yB = alignA?expectedY+displacement:expectedY;
    Object.assign(params,{slope,expectedY,left:{x1:170,y1:300-slope*210,x2:380,y2:300},
      rightA:{x1:580,y1:yA,x2:790,y2:yA+slope*210},rightB:{x1:580,y1:yB,x2:790,y2:yB+slope*210},
      occluder:{x:380,y:45,width:200,height:510}});
    const distance = line => Math.abs(line.y1-expectedY)/Math.sqrt(1+slope*slope);
    scene.a = distance(params.rightA);scene.b = distance(params.rightB);
    scene.answer = scene.a<scene.b?'a':'b';
    scene.choices = [{id:'a',label:'Aの線につながる'},{id:'b',label:'Bの線につながる'}];
    scene.question = '左の斜線をまっすぐ延ばすとどちらにつながりますか？';
    scene.measurements = [{label:'Aの線とのずれ',value:round(scene.a),unit:'図の単位'},{label:'Bの線とのずれ',value:round(scene.b),unit:'図の単位'}];
  } else if (GREY_IDS.has(id)) {
    scene.a = Math.round(between(112,145));
    scene.b = pairKind==='same'?scene.a:scene.a+(pairKind==='a'?-1:1)*level.grey;
    scene.answer = compared(scene.a,scene.b);
    scene.choices = ternaryChoices('明るい');
    scene.question = '中央のAとBはどちらが明るい色で塗られていますか？';
    scene.measurements = [{label:'Aに指定したRGB',value:`${scene.a}, ${scene.a}, ${scene.a}`,unit:'RGB'},{label:'Bに指定したRGB',value:`${scene.b}, ${scene.b}, ${scene.b}`,unit:'RGB'}];
    Object.assign(params,{backgroundA:flip?28:232,backgroundB:flip?232:28,stripeWidth:Math.round(between(42,64)),patchWidth:144});
    params.patchHeight = params.stripeWidth;
  } else if (id==='colour-contrast') {
    scene.a = Math.round(between(126,154));
    const unequal = truthMode==='random' && random()<.5;
    scene.b = unequal?scene.a+(flip?-1:1)*level.grey:scene.a;
    Object.assign(params,{colourA:[scene.a,145,151],colourB:[scene.b,145,151],backgroundA:[43,84,167],backgroundB:[248,177,81]});
    if (flip) [params.backgroundA,params.backgroundB]=[params.backgroundB,params.backgroundA];
    scene.answer = params.colourA.every((value,i)=>value===params.colourB[i])?'same':'different';
    scene.choices = [{id:'same',label:'同じ色で塗られている'},{id:'different',label:'違う色で塗られている'}];
    scene.question = '中央のAとBは同じ色で塗られていますか？';
    scene.measurements = [{label:'Aに指定したRGB',value:params.colourA.join(', '),unit:'RGB'},{label:'Bに指定したRGB',value:params.colourB.join(', '),unit:'RGB'}];
  } else if (id==='hermann') {
    Object.assign(params,{cells:Math.round(between(6,8)),corridor:round(16+level.strength*7),dotCount:0});
    scene.answer='none';scene.choices=[{id:'none',label:'灰色の点は描かれていない'},{id:'painted',label:'灰色の点が描かれている'}];
    scene.question='白い交差点に灰色の点は描かれていますか？';
    scene.measurements=[{label:'描画した灰色の点',value:0,unit:'個'}];
  } else if (id==='kanizsa') {
    Object.assign(params,{inducerRadius:round(58+level.strength*18+between(-5,5)),vertices:[{x:480,y:125},{x:270,y:450},{x:690,y:450}]});
    scene.answer='absent';scene.choices=[{id:'absent',label:'三角形の辺は描かれていない'},{id:'drawn',label:'三角形の辺が描かれている'}];
    scene.question='中央の三角形の辺は描かれていますか？';
    scene.measurements=[{label:'三角形の辺を結ぶ線',value:0,unit:'本'},{label:'切り欠きのある円',value:3,unit:'個'}];
  } else if (id==='fraser') {
    Object.assign(params,{radii:[38,72,106,140,174,208,242],tilt:round(15+level.strength*24+between(-5,5)),segments:[64,72,80][Math.floor(random()*3)]});
    scene.answer='circles';scene.choices=[{id:'circles',label:'それぞれ独立した円'},{id:'spiral',label:'一本の渦巻き'}];
    scene.question='輪の線は独立した円ですか？一本の渦巻きですか？';
    scene.measurements=[{label:'同心円の数',value:params.radii.length,unit:'本'},{label:'全ての円の中心',value:'480, 300',unit:'図の座標'}];
  }
  scene.answerText = answerFor(scene.choices,scene.answer);
  const quantified = scene.measurements.map(m=>`${m.label}：${typeof m.value==='number'?displayNumber(m.value):m.value}${m.unit==='RGB'?'':` ${m.unit}`}`).join(' ／ ');
  scene.explanation = `${item.principle} ${quantified}。`;
  return scene;
}

/** A shuffled cycle prevents repeated types until the selected pool is used. */
export function makeQuiz({seed=1,difficulty='standard',count=10,ids}={}) {
  levelSettings(difficulty);
  if (!Number.isInteger(count)||count<1||count>30) throw new RangeError('問題数は1〜30問にしてください。');
  const available = CATALOGUE.filter(item=>item.quiz).map(item=>item.id);
  if (ids!==undefined && !Array.isArray(ids)) throw new TypeError('出題する種類は配列で指定してください。');
  const pool = ids===undefined?available:[...new Set(ids)];
  if (!pool.length || pool.some(id=>!available.includes(id))) throw new RangeError('クイズで使う錯視を一つ以上選んでください。');
  const random=generator(normaliseSeed(seed)),scenes=[];
  let prior=null;
  while(scenes.length<count) {
    const cycle=pool.slice();
    for(let i=cycle.length-1;i>0;i--) { const j=Math.floor(random()*(i+1));[cycle[i],cycle[j]]=[cycle[j],cycle[i]]; }
    if(cycle.length>1 && cycle[0]===prior) [cycle[0],cycle[1]]=[cycle[1],cycle[0]];
    for(const id of cycle) {
      if(scenes.length===count) break;
      scenes.push(makeScene(id,{seed:Math.floor(random()*4294967296),difficulty,truthMode:'random'}));prior=id;
    }
  }
  return scenes;
}
