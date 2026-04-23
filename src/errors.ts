export class BaseUrlsInvalidFormatError extends Error {
  public constructor() {
    super();
  }
}

export class FailedToFetchBaseUrlsError extends Error {
  public constructor() {
    super();
  }
}

export class MissingVotingWorkerSeedError extends Error {
  public constructor() {
    super('Missing VOTING_WORKER_SEED');
  }
}

export class NodeRedRuntimeStartFailedError extends Error {
  public constructor() {
    super('Failed to start runtime');
  }
}

export class InvertObjectEmptyObjectError extends Error {
  public constructor() {
    super('Object to invert is empty');
  }
}

export class NodeRedNodePropertyNotFound extends Error {
  public constructor(nodeId: string, key: string) {
    super(`Node with id ${nodeId} not found on key ${key}`);
  }
}

export class BuildMetadataPathNotFoundError extends Error {
  public constructor() {
    super('BUILD_METADATA_PATH does not exist');
  }
}

export class UnableToDecodeSolutionGroup extends Error {
  public constructor() {
    super(`Unable to decode solution group`);
  }
}

export class UnableToObtainStakeError extends Error {
  public constructor() {
    super(`Unable to obtain stake`);
  }
}

export class LocalSolutionsFileNotFoundError extends Error {
  public constructor() {
    super(`Local solutions file not found`);
  }
}
