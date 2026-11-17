import { CATALOGUE } from './core.js';
import { lessonMarkup } from './lesson-view.js';

const container = document.getElementById('detailedLessons');
for (const item of CATALOGUE) {
  const details = document.createElement('details');
  details.className = 'lesson-detail';
  details.id = `lesson-${item.id}`;
  const summary = document.createElement('summary');
  summary.textContent = item.name;
  const body = document.createElement('div');
  body.innerHTML = lessonMarkup(item.id);
  const experiment = document.createElement('a');
  experiment.className = 'lesson-shortcut';
  experiment.href = `./?id=${encodeURIComponent(item.id)}#lab`;
  experiment.textContent = 'この錯視を実験室で試す →';
  body.querySelector('.lesson-content').append(experiment);
  details.append(summary, body);
  container.append(details);
}

function openLinkedLesson() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = document.getElementById(id);
  if (target?.matches('details.lesson-detail')) {
    target.open = true;
    target.scrollIntoView({ block: 'start' });
  }
}
openLinkedLesson();
window.addEventListener('hashchange', openLinkedLesson);
