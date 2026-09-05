const QUESTION_START = /^(?:who|what|when|where|why|how|which|whose|whom|is|are|am|was|were|do|does|did|can|could|would|will|should|may|might|have|has|had|tell me|explain|describe|show me|quien|quién|que|qué|cuando|cuándo|donde|dónde|por que|por qué|como|cómo|cual|cuál|cuanto|cuánto|es|son|era|eran|puede|puedes|podria|podría|podrias|podrías|deberia|debería|tiene|tienen|explica|explique|dime|cuentame|cuéntame|muestrame|muéstrame)\b/i;

export function looksLikeQuestion(text: string): boolean {
  const normalized = text.trim();
  const withoutOpeningMark = normalized.replace(/^¿\s*/, '');
  return normalized.endsWith('?') || normalized.startsWith('¿') || QUESTION_START.test(withoutOpeningMark);
}

export function mergeFinalTranscript(current: string, incoming: string): string {
  const left = current.trim();
  const right = incoming.trim();
  if (!left) return right;
  if (!right) return left;
  const leftFolded = left.toLocaleLowerCase();
  const rightFolded = right.toLocaleLowerCase();
  if (rightFolded.includes(leftFolded)) return right;
  if (leftFolded.includes(rightFolded)) return left;
  return `${left} ${right}`;
}
