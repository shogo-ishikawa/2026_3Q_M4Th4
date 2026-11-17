/* 手入力は0.1秒単位、上下の操作は1秒単位にする。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MotionTimeInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function readTime(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timeMaximum(value) {
    const number = readTime(value);
    return number !== null && number >= 0 ? number : Infinity;
  }

  function clampTime(value, maximum) {
    return Math.min(timeMaximum(maximum), Math.max(0, value));
  }

  function normaliseTime(value, maximum = Infinity) {
    const number = readTime(value);
    if (number === null) return null;
    // 最後に実際の長さへ収める。動画の末尾を0.1秒単位で切り捨てない。
    const rounded = Math.round(Math.max(0, number) * 10) / 10;
    return clampTime(rounded, maximum);
  }

  function stepTime(value, direction, maximum = Infinity) {
    if (direction !== 1 && direction !== -1) throw new Error('上下の操作には1または-1を指定します。');
    const number = readTime(value) ?? 0;
    // 0.4 + 1などの浮動小数点の端数を整え、現在の小数部分を残す。
    const shifted = Number((number + direction).toPrecision(15));
    return clampTime(shifted, maximum);
  }

  function bindTimeInput(input, { decreaseButton, increaseButton, getMaximum = () => input.max } = {}) {
    if (!input || !decreaseButton || !increaseButton)
      throw new Error('時刻の入力欄と、上下のボタンを指定してください。');
    input.step = '0.1';
    input.min = '0';
    let stepping = false;
    let manualEdit = false;

    function maximum() { return timeMaximum(getMaximum()); }
    function editable() { return !input.disabled && !input.readOnly; }

    function emitChange() {
      const EventClass = input.ownerDocument?.defaultView?.Event || Event;
      // ボタン操作で保った小数部分や正確な末尾を、手入力として丸めない。
      stepping = true;
      try {
        input.dispatchEvent(new EventClass('input', { bubbles: true }));
        input.dispatchEvent(new EventClass('change', { bubbles: true }));
      } finally { stepping = false; }
    }

    function move(direction) {
      if (!editable()) return;
      // 入力途中に矢印キーを押した場合も、手入力分を先に0.1秒単位へ整える。
      const current = manualEdit ? normaliseTime(input.value, maximum()) : input.value;
      manualEdit = false;
      const value = stepTime(current, direction, maximum());
      if (readTime(input.value) === value) return;
      input.value = String(value);
      emitChange();
    }

    function edited() { if (!stepping) manualEdit = true; }
    function commit() {
      if (!editable() || stepping) return;
      const value = normaliseTime(input.value, maximum());
      manualEdit = false;
      // 空欄や入力途中の値は、そのまま解析時の数値チェックへ渡す。
      if (value !== null) input.value = String(value);
    }
    function keydown(event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      // numberの標準操作（0.1秒の増減）が重ならないように止める。
      event.preventDefault();
      move(event.key === 'ArrowUp' ? 1 : -1);
    }
    function decrease() { if (!decreaseButton.disabled) move(-1); }
    function increase() { if (!increaseButton.disabled) move(1); }

    input.addEventListener('input', edited);
    input.addEventListener('change', commit);
    input.addEventListener('keydown', keydown);
    decreaseButton.addEventListener('click', decrease);
    increaseButton.addEventListener('click', increase);

    return Object.freeze({
      setValue(value) {
        const number = readTime(value);
        if (number === null) throw new Error('有限の秒数を指定してください。');
        // 読み込み・リセット時の動画の長さは、元の精度で保持する。
        manualEdit = false;
        input.value = String(clampTime(number, maximum()));
      },
      setDisabled(value) {
        input.disabled = Boolean(value);
        decreaseButton.disabled = Boolean(value);
        increaseButton.disabled = Boolean(value);
      },
      destroy() {
        input.removeEventListener('input', edited);
        input.removeEventListener('change', commit);
        input.removeEventListener('keydown', keydown);
        decreaseButton.removeEventListener('click', decrease);
        increaseButton.removeEventListener('click', increase);
      }
    });
  }

  return Object.freeze({ normaliseTime, stepTime, bindTimeInput });
});
