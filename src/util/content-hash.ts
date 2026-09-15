import { createHash } from 'crypto';

export const canonicalize = (value: unknown, ancestors: WeakSet<object> = new WeakSet()): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (ancestors.has(value)) {
    throw new Error('Cannot canonicalize a value with circular references');
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      return '[' + value.map((item) => canonicalize(item, ancestors)).join(',') + ']';
    }

    const keys = Object.keys(value).sort();

    return (
      '{' +
      keys
        .map(
          (key) => JSON.stringify(key) + ':' + canonicalize((value as Record<string, unknown>)[key], ancestors),
        )
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
};

export const hashProof = (proof: string): string => {
  const trimmed = proof.trim();
  const proofBytes = Buffer.from(trimmed, 'base64');

  if (proofBytes.toString('base64') !== trimmed.replace(/\s+/g, '')) {
    throw new Error('input is not canonical base64');
  }

  return createHash('sha256').update(proofBytes).digest('hex');
};
