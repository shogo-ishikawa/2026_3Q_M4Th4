import { CLASSES, SCENES, STAT_INFO, APPROACHES, CLUES, ENDINGS } from './data.js';
import { createGame, getScene, getChoices, previewChoice, resolveChoice, recover,
  advanceScene, finishGame, continueInvestigation, canContinueInvestigation,
  canAdvanceScene, canRecover, getStatusEffects, validateState, serialiseState } from './engine.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const SAVE_PREFIX = 'asterion.public.v1.';
const ARCHIVE_KEY = SAVE_PREFIX + 'endings';
const statNames = { hp:'体力', knowledge:'専門知識', focus:'集中力', evidence:'証拠', anomaly:'異常理解度', timeLeft:'残り時間' };
let game = null;
let selectedClass = null;
let selectedChoice = null;
let approach = 'balanced';
let useSkill = false;
let sideTab = 'status';
let storageAvailable = true;

function message(text = '') { $('message').textContent = text; }
function safely(action) {
  return async event => {
    try { await action(event); }
    catch (error) { message(error.message || '操作を完了できませんでした。'); }
  };
}
function showView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== name;
  $('titleButton').hidden = name === 'titleView';
}
function focusHeading(id) { $(id).focus({ preventScroll:true }); }
function jumpTo(element) {
  element.scrollIntoView({ block:'start', behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
function timeText(minute) { return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
function signed(value) { return value > 0 ? '+' + value : String(value); }
function classOf(state = game) { return CLASSES.find(item => item.id === state?.classId); }
function optionValues() { return { approach, useSkill }; }

function readSlot(kind) {
  try {
    const raw = localStorage.getItem(SAVE_PREFIX + kind);
    if (!raw) return null;
    const item = JSON.parse(raw);
    const state = validateState(item.state);
    return { state, savedAt:typeof item.savedAt === 'string' && Number.isFinite(Date.parse(item.savedAt)) ? item.savedAt : null };
  } catch { return null; }
}
function save(kind) {
  if (!game) return false;
  try {
    const checked = validateState(game);
    localStorage.setItem(SAVE_PREFIX + kind, JSON.stringify({ state:checked, savedAt:new Date().toISOString() }));
    storageAvailable = true;
    $('saveStatus').textContent = kind === 'manual' ? '手動セーブを保存しました。' : '自動保存済み';
    return true;
  } catch {
    storageAvailable = false;
    $('saveStatus').textContent = '端末への保存を利用できません。記録ファイルで保存できます。';
    return false;
  }
}
function archiveIds() {
  try {
    const value = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter(id => ENDINGS.some(ending => ending.id === id)))] : [];
  } catch { return []; }
}
function recordEnding() {
  if (!game?.ending) return;
  try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...new Set([...archiveIds(), game.ending.id])])); }
  catch { /* A file export still preserves this run and its ending. */ }
}
function renderArchive() {
  const ids = archiveIds();
  $('archiveCount').textContent = `${ids.length} / ${ENDINGS.length}`;
  $('endingArchive').innerHTML = ENDINGS.map((ending, index) => `<div class="archive-item${ids.includes(ending.id) ? ' discovered' : ''}"><b>${String(index + 1).padStart(2, '0')}</b>${ids.includes(ending.id) ? escape(ending.title.replace(/^END\s*\d+[:：]\s*/, '')) : '未観測の結末'}</div>`).join('');
  $('continueGame').hidden = !readSlot('auto') && !readSlot('manual');
}

function showTitle() { showView('titleView'); renderArchive(); message(); jumpTo($('main')); }
function showClasses() {
  selectedClass = null;
  $('startGame').disabled = true;
  $('classList').innerHTML = CLASSES.map(item => `<button type="button" class="class-card" data-class="${item.id}" aria-pressed="false"><b>${escape(item.name)}</b><span>${escape(item.skill)}</span><small>${escape(item.desc)}</small></button>`).join('');
  showView('classView'); message(); focusHeading('classTitle'); jumpTo($('main'));
}
function startNewGame() {
  if (!selectedClass) return;
  if (game && !game.done && !confirm('新しい調査を始めますか？残したい調査は先に記録ファイルへ保存してください。')) return;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  game = createGame(selectedClass, seed);
  selectedChoice = null; approach = 'balanced'; useSkill = false; sideTab = 'status';
  renderGame(); save('auto'); message('調査を開始しました。まず行動を選び、判定の見込みを確認しましょう。');
  focusHeading('sceneTitle'); jumpTo($('main'));
}

function clueNote(id) {
  const finding = [...game.history].reverse().find(entry => entry.clueIds?.includes(id));
  return finding ? finding.text.split('\n\n')[0] : (CLUES[id]?.description || '');
}
function renderStatus() {
  $('timeLeft').textContent = `${game.timeLeft}分`;
  $('storyClock').textContent = timeText(23 * 60 + 46 + (31 - game.timeLeft));
  document.querySelector('.mission-clock').classList.toggle('urgent', game.timeLeft <= 7);
  $('stats').innerHTML = STAT_INFO.map(stat => `<div class="stat" data-stat="${stat.id}" data-low="${game.stats[stat.id] <= 30}"><div class="stat-top"><span>${escape(stat.name)}</span><strong>${game.stats[stat.id]}<small>/100</small></strong></div><div class="stat-bar" role="progressbar" aria-label="${escape(stat.name)}" aria-valuenow="${game.stats[stat.id]}" aria-valuemin="0" aria-valuemax="100"><span style="width:${game.stats[stat.id]}%"></span></div><p class="stat-description">${escape(stat.description)}</p></div>`).join('');
  $('evidenceCount').textContent = game.evidence;
  $('anomalyCount').textContent = game.anomaly;
  $('statusEffects').innerHTML = getStatusEffects(game).map(effect => `<div class="effect ${['danger','negative','warning'].includes(effect.tone) ? 'danger' : ''}"><strong>${escape(effect.label)}</strong><p>${escape(effect.description)}</p></div>`).join('');
  $('clueList').innerHTML = game.clues.length ? game.clues.map(id => CLUES[id]).filter(Boolean).map(clue => `<article class="clue"><b>${escape(clue.title)}</b><p>${escape(clueNote(clue.id))}</p></article>`).join('') : '<p class="field-note">調査で見つけた手掛かりがここに残ります。別の調査を選ぶと異なる情報を得られます。</p>';
  $('historyList').innerHTML = game.history.length ? [...game.history].reverse().map(entry => `<li><strong>${escape(entry.choiceName || entry.name || entry.label || '調査の記録')}</strong>${escape(entry.label || entry.outcome || '')}${entry.timeCost ? ` · ${entry.timeCost}分` : ''}${Number.isInteger(entry.die) ? ` · D20 ${entry.die}` : ''}</li>`).join('') : '<li>まだ行動の記録はありません。</li>';
  selectSideTab(sideTab);
  if (!storageAvailable) $('saveStatus').textContent = '端末への保存を利用できません。記録ファイルで保存できます。';
}
function selectSideTab(name, focus = false) {
  sideTab = name;
  for (const button of document.querySelectorAll('[data-side]')) {
    const active = button.dataset.side === name;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    $(button.getAttribute('aria-controls')).hidden = !active;
    if (active && focus) button.focus();
  }
}

function renderChoices() {
  const choices = getChoices(game);
  $('choiceList').innerHTML = choices.map(choice => {
    const preview = previewChoice(game, choice.id, { approach:'balanced', useSkill:false });
    const match = choice.cat === '専門' || choice.cat === classOf().category;
    return `<button type="button" class="choice-card" data-choice="${choice.id}" aria-pressed="${selectedChoice === choice.id}"${choice.used || !choice.available ? ' disabled' : ''}><strong>${escape(choice.name)}</strong><p>${escape(choice.desc)}</p><div class="choice-meta"><span>${choice.used ? '調査済み' : `${preview.timeCost}分 · 成功率 ${preview.successChance}%`}</span><span>${match ? '専門適性あり' : escape(choice.cat)}</span></div>${choice.disabledReason ? `<p class="choice-reason">${escape(choice.disabledReason)}</p>` : ''}${preview.requirements?.length ? `<ul class="requirement-list">${preview.requirements.map(item => `<li class="${item.met ? 'met' : 'unmet'}">${item.met ? '✓' : '・'} ${escape(item.label)}</li>`).join('')}</ul>` : ''}</button>`;
  }).join('');
  $('actionCount').textContent = game.scene === SCENES.length - 1 ? '最後の選択' : `調査 ${game.sceneActions} / 2`;
  $('recoverButton').disabled = !canRecover(game);
  $('recoveryHelp').textContent = game.scene === SCENES.length - 1 ? '最後の操作を選んでください。条件が足りない場合も強制停止を選べます。' : game.recovered ? 'この章では休憩済みです。調査は別の行動を2つまで選べます。' : '休憩は各章1回。2分を使って体力と集中力を回復します。';
  $('advanceButton').hidden = !canAdvanceScene(game);
  $('advanceButton').textContent = game.timeLeft === 0 ? '最終操作へ進む' : '次の章へ進む';
  renderAction();
}
function renderAction() {
  const choice = getChoices(game).find(item => item.id === selectedChoice);
  $('actionPanel').hidden = !choice || !choice.available || game.phase !== 'choose';
  if ($('actionPanel').hidden) return;
  $('selectedAction').textContent = choice.name;
  let preview = previewChoice(game, selectedChoice, optionValues());
  if (useSkill && !preview.skillAvailable) { useSkill = false; preview = previewChoice(game, selectedChoice, optionValues()); }
  $('approachList').innerHTML = APPROACHES.map(item => `<button type="button" class="approach" data-approach="${item.id}" aria-pressed="${approach === item.id}" title="${escape(item.description)}"><b>${escape(item.name)}</b><span>${item.bonus > 0 ? '+' : ''}${item.bonus}補正 · ${item.timeDelta > 0 ? '+' : ''}${item.timeDelta}分</span></button>`).join('');
  $('useSkill').checked = useSkill; $('useSkill').disabled = !preview.skillAvailable;
  $('skillHelp').textContent = game.skillUsed ? 'この章では使用済みです。' : preview.skillAvailable ? `${classOf().skill} · 判定に+3。各章1回。` : 'この行動は専門能力の対象外です。';
  const bonuses = preview.bonuses;
  const costs = Object.entries(preview.costs).filter(([, value]) => value > 0).map(([key,value]) => `${statNames[key] || key} −${value}`).join(' / ');
  $('preview').innerHTML = `<div class="preview-title"><span>成功・大成功の見込み</span><strong class="chance">${preview.successChance}%</strong></div><div class="chance-bar" aria-hidden="true"><span style="width:${preview.successChance}%"></span></div><p>D20 ＋ 専門 ${signed(bonuses.class)} ＋ 状態 ${signed(bonuses.status)} ＋ 進め方 ${signed(bonuses.approach)} ＋ 能力 ${signed(bonuses.skill)}<br>難易度 ${preview.difficulty} 以上で成功</p><p><strong>所要 ${preview.timeCost}分</strong>${costs ? ` · ${escape(costs)}` : ''}</p>${preview.optionalRequirements?.length ? `<h4>別の解決法を見つける条件</h4><ul class="requirement-list">${preview.optionalRequirements.map(item => `<li class="${item.met ? 'met' : 'unmet'}">${item.met ? '✓' : '・'} ${escape(item.label)}</li>`).join('')}</ul>` : ''}${preview.warnings.map(warning => `<p class="choice-reason">${escape(warning)}</p>`).join('')}<p>出目1は重大な失敗、20は大成功です。部分成功でも手掛かりや理解を得られます。</p>`;
  $('resolveAction').disabled = !preview.available;
}

function renderResult() {
  const result = game.lastResult;
  $('resultPanel').hidden = game.phase !== 'result' || !result;
  if ($('resultPanel').hidden) return;
  $('resultTitle').textContent = result.label;
  $('dieFace').textContent = Number.isInteger(result.die) ? result.die : '休';
  $('rollMath').textContent = Number.isInteger(result.die) ? `出目 ${result.die} ＋ 補正 ${signed(Object.values(result.bonuses).reduce((sum, value) => sum + value, 0))} ＝ ${result.total} ／ 難易度 ${result.difficulty}` : `休憩 ${result.timeCost}分`;
  $('resultDelta').innerHTML = Object.entries(result.delta).filter(([, value]) => value !== 0).map(([key,value]) => `<span class="delta${value < 0 ? ' negative' : ''}">${statNames[key] || escape(key)} ${signed(value)}${key === 'timeLeft' ? '分' : ''}</span>`).join('');
  $('resultText').textContent = result.text;
  $('newClues').innerHTML = (result.clueIds || []).map(id => CLUES[id]).filter(Boolean).map(clue => `<div class="new-clue"><strong>手掛かり：${escape(clue.title)}</strong>${escape(clueNote(clue.id))}</div>`).join('');
  $('continueInvestigation').hidden = !canContinueInvestigation(game);
  $('nextScene').hidden = !canAdvanceScene(game) && game.scene !== SCENES.length - 1;
  $('nextScene').textContent = game.scene === SCENES.length - 1 ? '結末を見届ける' : game.timeLeft === 0 ? '最終操作へ進む' : '次の章へ進む';
}
function renderGame() {
  if (!game) return;
  if (game.phase === 'ending') { renderEnding(); return; }
  showView('playView');
  const scene = getScene(game);
  $('chapterLabel').textContent = `${scene.chapter} / ${game.scene + 1} OF ${SCENES.length}`;
  $('classLabel').textContent = `${classOf().name} · ${classOf().skill}`;
  $('chapterProgress').innerHTML = SCENES.map((item,index) => `<span class="${index < game.scene ? 'past' : index === game.scene ? 'current' : ''}" title="${escape(item.chapter)}"></span>`).join('');
  $('sceneTitle').textContent = scene.title;
  $('sceneBanner').textContent = scene.banner;
  $('sceneText').innerHTML = scene.text.map(text => `<p>${escape(text)}</p>`).join('');
  $('sceneDialogue').textContent = scene.dialogue || '';
  $('emergencyNotice').hidden = game.timeLeft > 0;
  $('emergencyNotice').textContent = game.scene === SCENES.length - 1 ? '起動時刻に達しました。追加調査はできません。集めた情報で最後の操作を選びます。' : '起動時刻に達しました。次は最終操作へ進みます。';
  $('investigationPanel').hidden = game.phase !== 'choose';
  renderStatus(); renderChoices(); renderResult();
}
function renderEnding() {
  showView('endingView'); recordEnding();
  $('endingTitle').textContent = game.ending.title;
  $('endingText').textContent = game.ending.body;
  $('endingSummary').textContent = `${classOf().name} · 証拠 ${game.evidence} · 異常理解度 ${game.anomaly} · 体力 ${game.stats.hp} · 専門知識 ${game.stats.knowledge} · 集中力 ${game.stats.focus} · 残り ${game.timeLeft}分`;
}
function updateGame(next, resultFocus = false) {
  game = next; selectedChoice = null; useSkill = false;
  message(); renderGame(); save('auto');
  if (resultFocus && game.phase === 'result') { focusHeading('resultTitle'); jumpTo($('resultPanel')); }
}
function nextScene() {
  if (game.scene === SCENES.length - 1 && game.phase === 'result') updateGame(finishGame(game));
  else updateGame(advanceScene(game));
  if (game.phase === 'ending') { focusHeading('endingTitle'); jumpTo($('main')); }
  else { focusHeading('sceneTitle'); jumpTo($('main')); }
}
function openLoadDialog() {
  $('saveSlots').innerHTML = ['auto','manual'].map(kind => {
    const slot = readSlot(kind), label = kind === 'auto' ? '自動保存' : '手動セーブ';
    return `<article class="save-slot"><h3>${label}</h3>${slot ? `<p>${escape(classOf(slot.state).name)} · ${escape(SCENES[slot.state.scene].chapter)}${slot.state.done ? ' · 調査終了' : ''}<br>${slot.savedAt ? escape(new Date(slot.savedAt).toLocaleString('ja-JP', { timeZone:'Asia/Tokyo' })) : ''}</p><button class="button" data-load="${kind}">この記録を開く</button>` : '<p>読み込める記録がありません。</p>'}</article>`;
  }).join('');
  $('loadDialog').showModal();
}
function openFilesDialog() { $('fileMessage').textContent = ''; $('exportGame').disabled = !game; $('filesDialog').showModal(); }
function restore(next) {
  game = validateState(next); selectedChoice = null; approach = 'balanced'; useSkill = false;
  renderGame(); save('auto'); message('調査の記録を読み込みました。判定結果もそのまま引き継いでいます。');
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  jumpTo($('main'));
}
function exportGame() {
  if (!game) throw Error('調査を始めてから保存してください。');
  const blob = new Blob([serialiseState(game)], { type:'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'ASTERION_調査記録.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('調査の記録ファイルを書き出しました。');
}

$('newGame').addEventListener('click', showClasses);
$('replayGame').addEventListener('click', showClasses);
$('continueGame').addEventListener('click', safely(openLoadDialog));
$('titleImport').addEventListener('click', openFilesDialog);
$('cancelSetup').addEventListener('click', showTitle);
$('titleButton').addEventListener('click', () => { if (game) save('auto'); showTitle(); });
$('endingTitleButton').addEventListener('click', showTitle);
$('classList').addEventListener('click', event => {
  const button = event.target.closest('[data-class]'); if (!button) return;
  selectedClass = button.dataset.class;
  for (const card of $('classList').querySelectorAll('button')) card.setAttribute('aria-pressed', String(card === button));
  $('startGame').disabled = false;
});
$('startGame').addEventListener('click', safely(startNewGame));
$('choiceList').addEventListener('click', safely(event => {
  const button = event.target.closest('[data-choice]'); if (!button || button.disabled) return;
  selectedChoice = button.dataset.choice; useSkill = false;
  renderChoices(); jumpTo($('actionPanel'));
}));
$('approachList').addEventListener('click', safely(event => { const button = event.target.closest('[data-approach]'); if (!button) return; approach = button.dataset.approach; renderAction(); }));
$('useSkill').addEventListener('change', safely(() => { useSkill = $('useSkill').checked; renderAction(); }));
$('resolveAction').addEventListener('click', safely(() => { if (!selectedChoice) return; updateGame(resolveChoice(game, selectedChoice, optionValues()), true); }));
$('recoverButton').addEventListener('click', safely(() => updateGame(recover(game), true)));
$('continueInvestigation').addEventListener('click', safely(() => { updateGame(continueInvestigation(game)); jumpTo($('investigationPanel')); }));
$('advanceButton').addEventListener('click', safely(nextScene));
$('nextScene').addEventListener('click', safely(nextScene));
$('saveGame').addEventListener('click', () => { message(save('manual') ? '手動セーブを保存しました。' : '端末への保存を利用できません。記録ファイルで保存してください。'); });
$('loadGame').addEventListener('click', safely(openLoadDialog));
$('saveSlots').addEventListener('click', safely(event => { const button = event.target.closest('[data-load]'); if (!button) return; const slot = readSlot(button.dataset.load); if (!slot) throw Error('この記録を読み込めません。'); restore(slot.state); }));
$('openFiles').addEventListener('click', openFilesDialog);
$('exportGame').addEventListener('click', safely(exportGame));
$('endingExport').addEventListener('click', safely(exportGame));
$('importGame').addEventListener('change', safely(async () => {
  const file = $('importGame').files[0]; if (!file) return;
  try { if (file.size > 250000) throw Error('記録ファイルは250KB以内で指定してください。'); const next = validateState(JSON.parse(await file.text())); restore(next); }
  catch (error) { $('fileMessage').textContent = `読み込めませんでした：${error instanceof SyntaxError ? 'JSONの書式を確認してください。' : error.message}`; }
  finally { $('importGame').value = ''; }
}));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const button of document.querySelectorAll('[data-side]')) {
  button.addEventListener('click', () => selectSideTab(button.dataset.side));
  button.addEventListener('keydown', event => {
    const keys = ['ArrowLeft','ArrowRight','Home','End']; if (!keys.includes(event.key)) return;
    event.preventDefault(); const names = ['status','clues','history'], index = names.indexOf(sideTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    selectSideTab(names[next], true);
  });
}
renderArchive();
