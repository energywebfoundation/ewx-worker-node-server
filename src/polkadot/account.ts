import { type KeyringPair } from '@polkadot/keyring/types';
import { Keyring } from '@polkadot/api';
import { MAIN_CONFIG } from '../config';

let keyringPair: KeyringPair | null = null;

export const createKeyringPair = (): KeyringPair => {
  if (keyringPair != null) {
    return keyringPair;
  }

  const property: string = MAIN_CONFIG.VOTING_WORKER_SEED;

  if (property === '' || property == null) {
    throw new Error('Missing VOTING_WORKER_SEED');
  }

  const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });

  if (property.startsWith('0x') || property.startsWith('_0x')) {
    return keyring.addFromUri(property.replace('_', ''));
  }

  keyringPair = keyring.addFromMnemonic(property);

  return keyringPair;
};
