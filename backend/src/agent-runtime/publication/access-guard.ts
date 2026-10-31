import { PublicationAccessCheckError, PublicationDefiniteFailureError,
  type PublicationAdapter } from "./publication.js";

export interface PublicationAccessGuardOptions {
  /** Only an explicit provider revocation/denial may permanently reject an undispatched write. */
  isAccessDenied?(cause: unknown): boolean;
}

/** Gate new writes without blocking reads that reconcile a previously sent request. */
export function guardPublicationAccess(
  adapter: PublicationAdapter,
  checkAccess: () => Promise<void>,
  options: PublicationAccessGuardOptions = {},
): PublicationAdapter {
  return {
    ...adapter,
    preflight: async (marker, payload) => {
      await checkAccess();
      await adapter.preflight?.(marker, payload);
    },
    dispatch: async (marker, payload, operation) => {
      try {
        await checkAccess();
      } catch (cause) {
        // The delegate has not been entered: this operation made no remote write.
        if (options.isAccessDenied?.(cause) === true) {
          throw new PublicationDefiniteFailureError(operation.businessOperationId,
            "provider_access_denied_before_dispatch", undefined, { cause });
        }
        throw new PublicationAccessCheckError(operation.businessOperationId,
          "provider_access_check_unavailable", { cause });
      }
      return adapter.dispatch(marker, payload, operation);
    },
  };
}
