import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const canonicalize = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';

  const keys = Object.keys(value).sort();

  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
};

export const hashProof = (proof: string): string => {
  const trimmed = proof.trim();
  const proofBytes = Buffer.from(trimmed, 'base64');

  if (proofBytes.toString('base64') !== trimmed.replace(/\s+/g, '')) {
    throw new Error('input is not canonical base64');
  }

  return createHash('sha256').update(proofBytes).digest('hex');
};
