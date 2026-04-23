import pino from 'pino';
import { MAIN_CONFIG } from '../config';
import { existsSync, readFileSync } from 'fs';
import { LocalSolutionsFileNotFoundError } from '../errors';

const localLogger = pino({
  name: 'LocalReaderLogger',
});

if (MAIN_CONFIG.LOCAL_SOLUTIONS_PATH != null) {
  if (!existsSync(MAIN_CONFIG.LOCAL_SOLUTIONS_PATH)) {
    localLogger.error(
      {
        path: MAIN_CONFIG.LOCAL_SOLUTIONS_PATH,
      },
      `smartflow file on this path does not exists`,
    );

    throw new LocalSolutionsFileNotFoundError();
  }
}

const contents: Record<string, { label: string; nodes: string }> | null =
  MAIN_CONFIG.LOCAL_SOLUTIONS_PATH != null
    ? JSON.parse(readFileSync(MAIN_CONFIG.LOCAL_SOLUTIONS_PATH).toString())
    : null;

export const localRead = (solutionWorkLogic: string): { label: string; nodes: string } | null => {
  if (contents == null) {
    localLogger.info('requested local solution but it does not have local SmartFlow files');

    return null;
  }

  return contents[solutionWorkLogic] ?? null;
};
