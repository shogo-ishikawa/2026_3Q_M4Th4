import { LESSONS } from './lessons.js';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

/** The same explanations appear with the figure, after a quiz and in the guide. */
export function lessonMarkup(id) {
  const lesson = LESSONS[id];
  if (!lesson) throw new RangeError('この錯視の解説が見つかりません。');
  const paragraphs = items => items.map(text => `<p>${escapeHtml(text)}</p>`).join('');
  const list = items => items.map(text => `<li>${escapeHtml(text)}</li>`).join('');
  const sources = lesson.sources.map(source => {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('参考資料のURLを確認してください。');
    return `<li><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a></li>`;
  }).join('');
  return `<div class="lesson-content">
    <div class="lesson-section"><h4>どこを見る？</h4>${paragraphs(lesson.look)}</div>
    <div class="lesson-section"><h4>なぜそう見える？</h4>${paragraphs(lesson.why)}</div>
    <div class="lesson-section"><h4>図を操作して確かめる</h4><ol>${list(lesson.verify)}</ol></div>
    <div class="lesson-section lesson-experiment"><h4>もう一歩、試してみよう</h4><ul>${list(lesson.try)}</ul></div>
    <div class="lesson-section lesson-sources"><h4>詳しく調べる</h4><ul>${sources}</ul></div>
  </div>`;
}
