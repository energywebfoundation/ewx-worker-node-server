// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
import { InvertObjectEmptyObjectError } from '../errors';

export const invertObject = (obj: Record<string, any>) => {
  if (obj == null) {
    throw new InvertObjectEmptyObjectError();
  }

  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [value, key]));
};
