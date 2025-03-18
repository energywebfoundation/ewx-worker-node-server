import type { KeyringPair } from '@polkadot/keyring/types';
import { u8aToHex } from '@polkadot/util';

export interface SignInPayload {
  address: string;
  domainName: string;
  signedAt: number;
  accountType: AccountType;
}

export class SignInDtoPayload {
  public address!: string;
  public signedAt!: number;
  public domainName!: string;
  public accountType!: AccountType;
}

export class SignInDto {
  public signature!: string;
  public payload!: SignInDtoPayload;
}

export enum AccountType {
  WORKER = 'WORKER',
}

export type JsonStringifiedPayload = string;
export type HexSignature = string;

export interface SignedMessage {
  constructedPayload: SignInPayload;
  stringifiedPayload: JsonStringifiedPayload;
  signature: HexSignature;
}

export const prepareSignInPayload = (
  payload: Omit<SignInPayload, 'address' | 'signedAt'>,
  account: KeyringPair,
): SignedMessage => {
  const constructedPayload: SignInPayload = {
    ...payload,
    address: account.address,
    signedAt: Date.now(),
  };

  const stringifiedPayload: string = JSON.stringify(constructedPayload);

  const signedMessage: string = u8aToHex(account.sign(stringifiedPayload));

  return {
    constructedPayload,
    signature: signedMessage,
    stringifiedPayload,
  };
};
