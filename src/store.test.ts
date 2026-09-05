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

describe('presentation mode state', () => {
  it('defaults to class mode with an empty slide deck', () => {
    expect(useStore.getState().sessionMode).toBe('class');
    expect(useStore.getState().slidePages).toEqual([]);
    expect(useStore.getState().slideScripts).toEqual([]);
  });

  it('loads a slide deck and resets the current index', () => {
    const store = useStore.getState();
    store.setSessionMode('presentation');
    store.setCurrentSlideIndex(5);
    store.setPresentationFinished(true);
    store.setPresentationPhase('outro');
    store.setSlideDeck(
      ['Slide 1 text', 'Slide 2 text'],
      [{ scriptEn: 'Script one', pronunciation: 'skript wan', scriptEs: 'Guion uno' }, { scriptEn: 'Script two', pronunciation: 'skript tu', scriptEs: 'Guion dos' }],
      { scriptEn: 'Hello everyone', pronunciation: 'JE-lou EV-ri-uan', scriptEs: 'Hola a todos' },
      { scriptEn: 'Thank you', pronunciation: 'zenk iu', scriptEs: 'Gracias' },
    );

    expect(useStore.getState().sessionMode).toBe('presentation');
    expect(useStore.getState().slidePages).toHaveLength(2);
    expect(useStore.getState().slideScripts[1].scriptEn).toBe('Script two');
    expect(useStore.getState().introScript?.scriptEn).toBe('Hello everyone');
    expect(useStore.getState().outroScript?.scriptEn).toBe('Thank you');
    expect(useStore.getState().currentSlideIndex).toBe(0);
    expect(useStore.getState().presentationPhase).toBe('intro');
    expect(useStore.getState().presentationFinished).toBe(false);
  });

  it('clamps the current slide index to the deck bounds', () => {
    const store = useStore.getState();
    store.setSlideDeck(
      ['Slide 1', 'Slide 2', 'Slide 3'],
      [{ scriptEn: 'A', pronunciation: 'ei', scriptEs: 'A' }, { scriptEn: 'B', pronunciation: 'bi', scriptEs: 'B' }, { scriptEn: 'C', pronunciation: 'si', scriptEs: 'C' }],
      null,
      null,
    );

    store.setCurrentSlideIndex(10);
    expect(useStore.getState().currentSlideIndex).toBe(2);

    store.setCurrentSlideIndex(-3);
    expect(useStore.getState().currentSlideIndex).toBe(0);
  });

  it('hides the teleprompter only when explicitly finished', () => {
    const store = useStore.getState();
    expect(useStore.getState().presentationFinished).toBe(false);
    store.setPresentationFinished(true);
    expect(useStore.getState().presentationFinished).toBe(true);
    store.setPresentationFinished(false);
    expect(useStore.getState().presentationFinished).toBe(false);
  });

  it('moves through intro, slides, and outro phases', () => {
    const store = useStore.getState();
    expect(useStore.getState().presentationPhase).toBe('intro');
    store.setPresentationPhase('slides');
    expect(useStore.getState().presentationPhase).toBe('slides');
    store.setPresentationPhase('outro');
    expect(useStore.getState().presentationPhase).toBe('outro');
  });
});
