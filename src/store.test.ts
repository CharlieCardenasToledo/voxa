import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';

beforeEach(() => {
  useStore.getState().startLive(false);
});

describe('live session state', () => {
  it('deduplicates and bounds queued questions', () => {
    const store = useStore.getState();
    store.setActiveQuestion('Current question');
    for (let index = 0; index < 25; index += 1) store.enqueueQuestion(`Question ${index}`);
    store.enqueueQuestion('Question 24');

    expect(useStore.getState().questionQueue).toHaveLength(20);
    expect(useStore.getState().questionQueue[19]).toBe('Question 24');
  });

  it('keeps only a bounded transcript window', () => {
    const store = useStore.getState();
    for (let index = 0; index < 250; index += 1) {
      store.addTurn({ id: String(index), speaker: 'THEM', text: `Line ${index}`, time: '10:00' });
    }

    expect(useStore.getState().turns).toHaveLength(200);
    expect(useStore.getState().turns[0].id).toBe('50');
  });
});
