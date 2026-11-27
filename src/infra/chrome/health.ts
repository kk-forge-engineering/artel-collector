import { CollectionState, Mode } from "../../shared/collectorTypes.js";
import { isHealthOperation, OPERATION, type HealthOperation } from "../../shared/health.js";
import { forwardTrack, newExtensionCollectorOn } from "./extension.js";

export type { HealthOperation } from "../../shared/health.js";

export interface HealthOptions {
  key: string;
  origin: string;
  version?: string;
  uiLanguage?: string;
  errorCodes?: readonly string[];
  uninstallPage?: string;
  onError?: (error: Error) => void;
}

export interface HealthContentScriptCollector {
  record(operation: HealthOperation): Promise<void>;
}

export interface HealthCollector extends HealthContentScriptCollector {
  flush(): Promise<void>;
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
}

/** Builds the collector in a trusted extension page or at the top level of the service worker. */
export function newHealthCollector({
  key,
  origin,
  version,
  uiLanguage,
  errorCodes = [],
  uninstallPage,
  onError,
}: HealthOptions): HealthCollector {
  const collector = newExtensionCollectorOn(
    {
      key,
      endpoint: healthEndpoint(origin),
      mode: Mode.Anonymous,
      version,
      uiLanguage,
      uninstallPage: feedbackPage(uninstallPage),
      onError,
    },
    new Set(errorCodes),
  );
  return {
    record: (operation) => collector.track(OPERATION, operation),
    flush: () => collector.flush(),
    isEnabled: async () => (await collector.getState()) !== CollectionState.OptedOut,
    setEnabled: (enabled) =>
      collector.setState(enabled ? CollectionState.Anonymous : CollectionState.OptedOut),
  };
}

/** Hands an operation to the worker without reading extension storage or making a request. */
export function newHealthContentScriptCollector(): HealthContentScriptCollector {
  return {
    record: async (operation) => {
      try {
        if (isHealthOperation(operation)) {
          await forwardTrack(OPERATION, operation);
        }
      } catch {
        // A content script has no reporter. The worker validates the operation again.
      }
    },
  };
}

function healthEndpoint(origin: string): string {
  const url = new URL(origin);
  if (url.href !== url.origin + "/") {
    throw new TypeError("artel: health origin must be an origin without a path or credentials");
  }
  return new URL("/v1/public/health", url).href;
}

function feedbackPage(page: string | undefined): string | undefined {
  if (page === undefined) {
    return undefined;
  }
  const url = new URL(page);
  if (url.protocol !== "https:" || url.href !== url.origin + url.pathname) {
    throw new TypeError(
      "artel: health uninstall page must be an HTTPS URL without credentials, query or fragment",
    );
  }
  return url.href;
}
