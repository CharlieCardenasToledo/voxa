import { describe, expect, it } from 'vitest';
import { looksLikeQuestion, mergeFinalTranscript } from './transcript';

describe('live transcript helpers', () => {
  it('joins fragments split by a short VAD pause', () => {
    expect(mergeFinalTranscript('Could you explain', 'how the cache works?'))
      .toBe('Could you explain how the cache works?');
  });

  it('does not duplicate cumulative final transcripts', () => {
    expect(mergeFinalTranscript('What about security?', 'What about security?'))
      .toBe('What about security?');
  });

  it('recognizes English and Spanish questions without punctuation', () => {
    expect(looksLikeQuestion('Could you explain the fallback')).toBe(true);
    expect(looksLikeQuestion('¿Cómo funciona el caché')).toBe(true);
    expect(looksLikeQuestion('The cache is enabled')).toBe(false);
  });
});
