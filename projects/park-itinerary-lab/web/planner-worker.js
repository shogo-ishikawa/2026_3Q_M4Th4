import { solveItinerary } from './planner.js?v=1.9.0';

self.onmessage = event => {
  const input = event.data || {};
  if (input.type !== 'solve') return;
  const { requestId, park, initialPlan } = input;
  const settings = { ...input.settings };
  if (Array.isArray(input.history)) settings.history = input.history;
  try {
    const result = solveItinerary(park, settings, {
      initialPlan,
      onProgress: progress => {
        const { preview, ...details } = progress;
        self.postMessage({ type: 'progress', requestId, progress: details, result: preview || undefined });
      },
    });
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : '条件を確認してください。';
    self.postMessage({ type: 'error', requestId, message, error: message });
  }
};
