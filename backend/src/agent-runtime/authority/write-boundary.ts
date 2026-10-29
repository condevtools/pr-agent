import { AsyncLocalStorage } from "node:async_hooks";

import { isDurablePublicationEnabled } from "../publication/mode.js";
import type { PublicationOperation, PublicationPlatform } from "../publication/publication.js";

interface PublicationWriteAuthority {
  active: boolean;
  businessOperationId: string;
  generation: number;
  platform: PublicationPlatform;
}

const authorityStorage = new AsyncLocalStorage<PublicationWriteAuthority>();

export async function withPublicationWriteAuthority<T>(
  operation: PublicationOperation,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isDurablePublicationEnabled()) return callback();
  const generation = operation.scope.authorityGeneration;
  if (!Number.isSafeInteger(generation) || generation === undefined || generation <= 0) {
    throw new PublicationWriteBoundaryError(operation.scope.platform);
  }
  const authority: PublicationWriteAuthority = {
    active: true,
    businessOperationId: operation.businessOperationId,
    generation,
    platform: operation.scope.platform,
  };
  return authorityStorage.run(authority, async () => {
    try {
      return await callback();
    } finally {
      // Detached async work inherits the object reference, so revoke it explicitly.
      authority.active = false;
    }
  });
}

export function assertPublicationWriteAllowed(platform: PublicationPlatform): void {
  if (!isDurablePublicationEnabled()) return;
  const authority = authorityStorage.getStore();
  if (
    !authority?.active ||
    authority.platform !== platform ||
    !Number.isSafeInteger(authority.generation) ||
    authority.generation <= 0
  ) {
    throw new PublicationWriteBoundaryError(platform);
  }
}

export class PublicationWriteBoundaryError extends Error {
  constructor(readonly platform: PublicationPlatform) {
    super(`durable ${platform} mutation requires a claimed publication operation`);
    this.name = "PublicationWriteBoundaryError";
  }
}
