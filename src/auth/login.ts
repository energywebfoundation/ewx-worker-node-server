import { type KeyringPair } from '@polkadot/keyring/types';
import axios from 'axios';
import { MAIN_CONFIG } from '../config';
import { createLogger } from '../util';
import { AccountType, prepareSignInPayload, type SignInDto } from './sign-in-payload';

const logger = createLogger('Auth');

export const createToken = async (account: KeyringPair): Promise<string | null> => {
  const signedPayload = prepareSignInPayload(
    {
      accountType: AccountType.WORKER,
      domainName: MAIN_CONFIG.PALLET_AUTH_SERVER_DOMAIN,
    },
    account,
  );

  const payload: SignInDto = {
    payload: signedPayload.constructedPayload,
    signature: signedPayload.signature,
  };

  logger.info(
    {
      address: account.address,
    },
    `preparing signed payload`,
  );

  const result = await axios
    .post(MAIN_CONFIG.PALLET_AUTH_SERVER_LOGIN_URL, {
      ...payload,
    })
    .catch((e) => {
      logger.error(
        {
          address: account.address,
        },
        'failed to sign-in',
      );

      logger.error(e.message);
      logger.error(e.response.data);

      return null;
    });

  if (result === null) {
    logger.warn(
      {
        address: account.address,
      },
      'unable to sign-in',
    );

    return null;
  }

  logger.info(
    {
      address: account.address,
    },
    `retrieved token`,
  );

  return result.data.accessToken;
};
