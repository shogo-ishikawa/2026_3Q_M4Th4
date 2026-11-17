import {GUIDE_HTML,LESSON_NOTES,PREDICTIONS} from './learning-content.js';
import {wallMeasurement} from './wall-measurement.js';

const decimal=(value,digits=5)=>Number.isFinite(value)?value.toFixed(digits):'対象外';

export function createLearningTools(){
  const $=id=>document.getElementById(id);
  $('learningGuide').innerHTML=GUIDE_HTML;
  let currentKey='';
  const answers=new Map();
  const choiceButtons=[];
  function showLesson(id,mode){
    const key=id+'/'+mode;
    if(currentKey===key)return;
    currentKey=key;
    const a=LESSON_NOTES[id]??{
      observation:'条件を一つだけ変えましょう。速さの分布と壁付近の傾きを比べてください。',
      reason:'何を同じにして何を変えたかを確認しましょう。条件を整理すると変化の理由を説明しやすくなります。',
      limit:'計算から言えることは方法ごとに違います。下の詳しい解説で各方法の役割を確認できます。'};
    for(const field of ['observation','reason','limit'])$('lesson'+field[0].toUpperCase()+field.slice(1)).textContent=a[field];
    const p=PREDICTIONS[id];
    $('predictionPanel').hidden=!p;
    $('predictionChoices').replaceChildren();choiceButtons.length=0;
    if(!p)return;
    $('predictionQuestion').textContent=p.question;
    $('predictionFeedback').textContent=answers.has(id)?p.choices[answers.get(id)].feedback:'選ぶと理由を確認できます。予想と違っていたらその理由も考えてみましょう。';
    p.choices.forEach((choice,i)=>{
      const b=document.createElement('button');b.type='button';b.className='prediction-choice';b.textContent=choice.label;
      b.setAttribute('aria-pressed',String(answers.get(id)===i));
      b.addEventListener('click',()=>{
        answers.set(id,i);choiceButtons.forEach((button,j)=>button.setAttribute('aria-pressed',String(i===j)));
        $('predictionFeedback').textContent=choice.feedback;
      });
      choiceButtons.push(b);$('predictionChoices').append(b);
    });
  }
  function updateWall(d,accuracy){
    const m=wallMeasurement(d);
    $('wallMeasurement').classList.toggle('measurement-alert',Boolean(m.available&&accuracy?.exceeded));
    $('wallResult').hidden=!m.available;
    $('wallUnavailable').hidden=m.available;
    $('wallUnavailable').textContent=m.available?'':m.reason;
    if(!m.available){$('wallStatus').textContent='この状態では壁の摩擦係数を推定しません。';return}
    $('wallMeasuredF').textContent=decimal(m.friction,5);
    $('wallReferenceF').textContent=m.referenceApplicable?decimal(m.referenceF,5):'—';
    $('wallDifference').textContent=m.referenceApplicable?decimal(m.relativeDifference*100,3)+' %':'比較対象外';
    $('wallTau').textContent=decimal(m.shearStress,6)+' Pa';
    $('wallMeanRe').textContent=decimal(m.actualRe,2);
    $('wallSlope').textContent=decimal(m.wallSlope,5);
    $('wallStatus').textContent=accuracy?.exceeded?'精度の目安を超えています。この値から物理的な結論を出さないでください。':
      d.time===0?'初期状態の値です。計算を進めて変化を観察しましょう。':
      m.referenceApplicable?'壁付近の速度の変わり方から求めた値です。粒子数を変えた計算でも同じ時刻の値を比べてみましょう。':'流速が時間とともに変化しています。時間がたっても流れが変わらない状態の式とは比較しません。';
  }
  return {showLesson,updateWall};
}
