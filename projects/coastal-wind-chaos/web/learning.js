/* 図と小さな実験は教材用。実際の予報モデルの計算はColab側が担当する。 */
(function (root) {
  "use strict";
  const COMPASS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
  function normalise(angle) { return ((angle % 360) + 360) % 360; }
  function angularDifference(first, second) { return Math.abs(((normalise(first) - normalise(second) + 540) % 360) - 180); }
  function windVector(speed, fromDegrees) {
    const radians = fromDegrees * Math.PI / 180;
    return {u: -speed * Math.sin(radians), v: -speed * Math.cos(radians)};
  }
  function calculateMetrics(observed, predicted) {
    if (!Array.isArray(observed) || !Array.isArray(predicted) || observed.length !== predicted.length || !observed.length) throw new Error("同じ長さの観測と予測が必要です。");
    const errors = observed.map((value, index) => {
      if (!Number.isFinite(value) || !Number.isFinite(predicted[index])) throw new Error("有限な数値で比較してください。");
      return predicted[index] - value;
    });
    const n = errors.length;
    return {mae: errors.reduce((sum, error) => sum + Math.abs(error), 0) / n,
      rmse: Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / n),
      bias: errors.reduce((sum, error) => sum + error, 0) / n};
  }
  function toyData(bias = 0, outlier = false) {
    const observed = [2, 3, 4, 3, 5, 4, 6, 5];
    const predicted = observed.map((value, index) => value + (index % 2 ? .5 : -.5) + bias + (outlier && index === 5 ? 6 : 0));
    return {observed, predicted};
  }
  const api = {angularDifference, windVector, calculateMetrics, toyData};
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WindLearning = api;
  if (!root.document) return;
  const document = root.document;
  const byId = id => document.getElementById(id);
  const speedInput = byId("wind-speed"), directionInput = byId("wind-direction");
  if (!speedInput || !directionInput) return;

  const canvas = byId("wind-field"), context = canvas && canvas.getContext("2d");
  const motionPreference = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)") : {matches: false};
  let paused = motionPreference.matches;
  let speed = Number(speedInput.value), direction = Number(directionInput.value);
  let previousFrame = null, animationFrame = null;
  const particles = Array.from({length: 85}, (_, index) => ({x: ((index * 137.507) % 640), y: ((index * 89.121) % 580), age: index % 70}));
  const motionButton = byId("motion-toggle");
  function showMotionState() { motionButton.textContent = paused ? "動きを再生" : "動きを止める"; motionButton.setAttribute("aria-pressed", String(paused)); }
  function drawWind(timestamp) {
    if (!context) return;
    const elapsed = previousFrame === null ? 1 : Math.min((timestamp - previousFrame) / 16.67, 2);
    previousFrame = timestamp;
    const width = canvas.width, height = canvas.height;
    context.fillStyle = paused ? "#102e4b" : "rgba(16,46,75,.15)";
    context.fillRect(0, 0, width, height);
    const vector = windVector(speed, direction);
    particles.forEach((particle, index) => {
      const oldX = particle.x, oldY = particle.y;
      const multiplier = .35 + (index % 5) * .075;
      if (!paused) {
        particle.x = (particle.x + vector.u * multiplier * elapsed + width) % width;
        particle.y = (particle.y - vector.v * multiplier * elapsed + height) % height;
      }
      context.strokeStyle = index % 4 ? "rgba(155,215,235,.28)" : "rgba(70,219,236,.66)";
      context.lineWidth = index % 4 ? 1 : 1.6;
      context.beginPath();
      const fromX = paused ? particle.x - vector.u * 2.4 : oldX;
      const fromY = paused ? particle.y + vector.v * 2.4 : oldY;
      if (Math.abs(particle.x - fromX) < width / 2 && Math.abs(particle.y - fromY) < height / 2) {
        context.moveTo(fromX, fromY); context.lineTo(particle.x, particle.y); context.stroke();
      }
      if (!speed || paused) { context.fillStyle = "rgba(125,207,232,.4)"; context.fillRect(particle.x, particle.y, 1.3, 1.3); }
    });
    if (!paused && !document.hidden) animationFrame = root.requestAnimationFrame(drawWind);
  }
  function restartWind() {
    if (animationFrame !== null) root.cancelAnimationFrame(animationFrame);
    animationFrame = null; previousFrame = null;
    if (context) { context.fillStyle = "#102e4b"; context.fillRect(0, 0, canvas.width, canvas.height); }
    if (!document.hidden) drawWind(root.performance.now());
  }
  function updateWind() {
    speed = Number(speedInput.value); direction = normalise(Number(directionInput.value));
    const from = COMPASS[Math.round(direction / 22.5) % 16];
    const to = COMPASS[(Math.round(direction / 22.5) + 8) % 16];
    byId("wind-speed-value").textContent = speed.toFixed(1) + " m/s";
    byId("wind-direction-value").textContent = speed ? from + " / " + direction + "°" : "風向なし";
    byId("hero-speed").textContent = speed.toFixed(1);
    byId("hero-direction").textContent = speed ? from + "から" + to + "へ" : "風速0 m/s・向きは定まりません";
    byId("wind-arrow").setAttribute("transform", "translate(150 150) rotate(" + (direction + 180) + ")");
    byId("wind-arrow").style.opacity = speed ? "1" : "0";
    byId("wind-explanation").textContent = speed ? from + "風は、" + from + "から" + to + "へ吹く風です。" : "風速0 m/sでは風がないため、風向を決められません。";
    byId("compass-title").textContent = speed ? from + "から" + to + "へ風が進む方位図" : "風速0 m/sのため風向はありません";
    byId("speed-kmh").textContent = "時速" + (speed * 3.6).toFixed(1) + " kmに相当";
    byId("speed-kmh").previousElementSibling.textContent = speed.toFixed(1) + " m/sなら、1秒で" + speed.toFixed(1) + " m進む速さ";
    restartWind();
  }
  speedInput.addEventListener("input", updateWind); directionInput.addEventListener("input", updateWind);
  motionButton.addEventListener("click", () => { paused = !paused; showMotionState(); restartWind(); });
  document.addEventListener("visibilitychange", restartWind);
  if (motionPreference.addEventListener) motionPreference.addEventListener("change", event => { paused = event.matches; showMotionState(); restartWind(); });
  showMotionState(); updateWind();

  function changeBreeze(day) {
    byId("breeze-day").setAttribute("aria-pressed", String(day));
    byId("breeze-night").setAttribute("aria-pressed", String(!day));
    byId("breeze-arrow").setAttribute("d", day ? "M120 190H400" : "M400 190H120");
    byId("breeze-sky").setAttribute("fill", day ? "#f1b450" : "#5a6c9b");
    byId("breeze-land-label").textContent = day ? "陸が温まりやすい" : "陸が冷えやすい";
    byId("breeze-caption").textContent = day ? "穏やかに晴れた昼の一例。陸が海より温まり、海から陸へ吹く海風が生じることがあります。" : "穏やかに晴れた夜の一例。陸が海より冷え、陸から海へ吹く陸風が生じることがあります。";
  }
  byId("breeze-day").addEventListener("click", () => changeBreeze(true));
  byId("breeze-night").addEventListener("click", () => changeBreeze(false));

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgNode(name, attributes, text) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function updateErrors() {
    const bias = Number(byId("error-bias").value), outlier = byId("error-outlier").checked;
    const {observed, predicted} = toyData(bias, outlier), metrics = calculateMetrics(observed, predicted);
    byId("error-bias-value").textContent = (bias >= 0 ? "+" : "") + bias.toFixed(2) + " m/s";
    byId("toy-mae").textContent = metrics.mae.toFixed(2);
    byId("toy-rmse").textContent = metrics.rmse.toFixed(2);
    byId("toy-bias").textContent = (metrics.bias >= 0 ? "+" : "") + metrics.bias.toFixed(2);
    byId("error-explanation").textContent = outlier ? "1点の大きな外れで、RMSEがMAEより強く反応します。平均だけでなく、どの時刻で外れたかも見てみましょう。" : Math.abs(metrics.bias) < .01 ? "偏りが0でも、毎回当たっているとは限りません。プラスとマイナスのずれが打ち消し合うことがあります。" : "予測を全体にずらすと偏りも変わります。正なら強く、負なら弱く予測する傾向を表します。";
    const chart = byId("error-chart");
    chart.replaceChildren(svgNode("title", {id: "error-chart-title"}, "教材用の架空の8時点。観測と予測の風速を比較します"));
    const narrow = chart.getBoundingClientRect().width < 450;
    const viewWidth = narrow ? 400 : 640;
    chart.setAttribute("viewBox", "0 0 " + viewWidth + " 280");
    const max = Math.max(8, Math.ceil(Math.max(...observed, ...predicted) / 2) * 2), left = narrow ? 37 : 50, top = 20, width = viewWidth - left - 25, height = 215;
    const axisFont = narrow ? 13 : 11;
    const x = index => left + index * width / 7, y = value => top + height - value / max * height;
    for (let tick = 0; tick <= max; tick += 2) {
      chart.append(svgNode("line", {x1: left, x2: left + width, y1: y(tick), y2: y(tick), stroke: "#e1eaf1"}));
      chart.append(svgNode("text", {x: left - 10, y: y(tick) + 4, "text-anchor": "end", fill: "#5c7186", "font-size": axisFont}, tick));
    }
    chart.append(svgNode("text", {x: 4, y: 12, fill: "#5c7186", "font-size": axisFont}, "m/s"));
    observed.forEach((_, index) => chart.append(svgNode("text", {x: x(index), y: top + height + 22, "text-anchor": "middle", fill: "#5c7186", "font-size": axisFont}, index + 1)));
    chart.append(svgNode("text", {x: left + width, y: 275, "text-anchor": "end", fill: "#5c7186", "font-size": axisFont}, "時点（架空）"));
    observed.forEach((value, index) => chart.append(svgNode("line", {x1: x(index), x2: x(index), y1: y(value), y2: y(predicted[index]), stroke: "#b7cbed", "stroke-width": 3, "stroke-dasharray": "3 3"})));
    [[observed, "#234860"], [predicted, "#2458ed"]].forEach(([series, colour]) => {
      chart.append(svgNode("polyline", {points: series.map((value, index) => x(index) + "," + y(value)).join(" "), fill: "none", stroke: colour, "stroke-width": 2.5}));
      series.forEach((value, index) => chart.append(svgNode("circle", {cx: x(index), cy: y(value), r: 4, fill: colour, stroke: "white", "stroke-width": 1.5})));
    });
  }
  byId("error-bias").addEventListener("input", updateErrors);
  byId("error-outlier").addEventListener("change", updateErrors);
  byId("error-reset").addEventListener("click", () => { byId("error-bias").value = "0"; byId("error-outlier").checked = false; updateErrors(); });
  updateErrors();
  root.addEventListener("resize", updateErrors);

  let scrollPending = false;
  function updateProgress() {
    const available = document.documentElement.scrollHeight - root.innerHeight;
    byId("reading-progress").style.width = (available > 0 ? Math.min(100, root.scrollY / available * 100) : 0) + "%";
    scrollPending = false;
  }
  root.addEventListener("scroll", () => { if (!scrollPending) { scrollPending = true; root.requestAnimationFrame(updateProgress); } }, {passive: true});
  updateProgress();
  if (root.IntersectionObserver) {
    const observer = new root.IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        document.querySelectorAll(".chapter-links a").forEach(link => {
          if (link.hash === "#" + entry.target.id) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current");
        });
      });
    }, {rootMargin: "-20% 0px -65% 0px", threshold: 0});
    ["feel", "forecast", "verify", "errors", "practice"].forEach(id => observer.observe(byId(id)));
  }
})(typeof window !== "undefined" ? window : globalThis);
