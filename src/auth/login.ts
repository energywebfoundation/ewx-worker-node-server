import { type KeyringPair } from '@polkadot/keyring/types';
import axios from 'axios';
import { MAIN_CONFIG } from '../config';
import { AccountType, prepareSignInPayload, type SignInDto } from './sign-in-payload';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createLogger } from '../util/logger';
import { createKeyringPair } from '../polkadot/account';
import { type BaseUrlsConfig, getBaseUrls } from '../util/base-urls';

const authResponseSchema = z.object({
  accessToken: z.string(),
});

export type AuthResponse = z.infer<typeof authResponseSchema>;

const logger = createLogger('Auth');

let token: { token: string; expiresAt: number } | null = null;

export const getToken = async (): Promise<string | null> => {
  try {
    const account: KeyringPair = createKeyringPair();

    if (token == null || token.expiresAt - 60 < getCurrentTimestampInSeconds()) {
      token = await createToken(account);
    }

    if (token == null) {
      return null;
    }

    return token.token;
  } catch (e) {
    logger.error('failed to get token, fallbacking to null');
    logger.error(e);

    return null;
  }
};

const decodeToken = (token: string): { expiresAt: number } | null => {
  const decoded = jwt.decode(token, {
    json: true,
    complete: true,
  });

  if (decoded == null) {
    logger.error('unable to decode token, it is malformed or corrupted');

    return null;
  }

  if (typeof decoded.payload === 'string') {
    logger.error(
      {
        payload: decoded.payload,
      },
      'token payload is not an object',
    );

    return null;
  }

  if (decoded.payload.exp == null) {
    logger.error(
      {
        payload: decoded.payload,
      },
      'token expiration is not provided',
    );

    return null;
  }

  logger.info(
    {
      issuer: decoded.payload.iss,
      subject: decoded.payload.sub,
      audience: decoded.payload.aud,
      expiration: decoded.payload.exp,
      issuedAt: decoded.payload.iat,
    },
    'decoded token',
  );

  return {
    expiresAt: decoded.payload.exp,
  };
};

export const createToken = async (
  account: KeyringPair,
): Promise<{ token: string; expiresAt: number } | null> => {
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

  const accessToken = await obtainTokenFromAuthServer(payload, account);

  if (accessToken === null) {
    logger.warn(
      {
        address: account.address,
      },
      'unable to sign-in',
    );

    return null;
  }

  const decodedToken = decodeToken(accessToken);

  if (decodedToken == null) {
    logger.warn(
      {
        address: account.address,
      },
      'unable to decode token',
    );

    return null;
  }

  logger.info(
    {
      address: account.address,
    },
    `retrieved token`,
  );

  return {
    token: accessToken,
    expiresAt: decodedToken?.expiresAt,
  };
};

const getCurrentTimestampInSeconds = (): number => {
  return Math.floor(Date.now() / 1000);
};

const obtainTokenFromAuthServer = async (
  payload: SignInDto,
  account: KeyringPair,
): Promise<string | null> => {
  const baseUrls: BaseUrlsConfig = await getBaseUrls();

  const authUrl: string = baseUrls.authServerUrl.includes('api/auth/login')
    ? baseUrls.authServerUrl
    : `${baseUrls.authServerUrl}/api/auth/login`;

  logger.info(
    {
      authServerUrl: authUrl,
    },
    'attempting to sign-in',
  );

  const result: AuthResponse | null = await axios
    .post(authUrl, {
      ...payload,
    })
    .then((r) => {
      try {
        return authResponseSchema.parse(r.data);
      } catch (e) {
        logger.error('failed to parse response');
        logger.error(e);

        return null;
      }
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

  if (result == null) {
    return null;
  }

  return result.accessToken;
};
