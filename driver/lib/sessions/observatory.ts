import {URL} from 'node:url';

import {retryInterval} from 'asyncbox';
import _ from 'lodash';

import type {FlutterDriver} from '../driver.js';
import {decode} from './base64url.js';
import {IsolateSocket} from './isolate_socket.js';
import type {LogEntry} from './log-monitor.js';

const truncateLength = 500;
// https://github.com/flutter/flutter/blob/f90b019c68edf4541a4c8273865a2b40c2c01eb3/dev/devicelab/lib/framework/runner.dart#L183
//  e.g. 'Observatory listening on http://127.0.0.1:52817/_w_SwaKs9-g=/'
// https://github.com/flutter/flutter/blob/52ae102f182afaa0524d0d01d21b2d86d15a11dc/packages/flutter_tools/lib/src/resident_runner.dart#L1386-L1389
//  e.g. 'An Observatory debugger and profiler on ${device.device.name} is available at: http://127.0.0.1:52817/_w_SwaKs9-g=/'
export const OBSERVATORY_URL_PATTERN = new RegExp(
  `(Observatory listening on |` +
    `An Observatory debugger and profiler on\\s.+\\sis available at: |` +
    `The Dart VM service is listening on )` +
    `((http|//)[a-zA-Z0-9:/=_\\-.\\[\\]]+)`,
);

const moduleCheckIntervalCount = 30;
const moduleCheckIntervalMs = 500;

// The observatory URL is only known once it's been printed to the device log (see
// 'getObservatoryWsUri'), which is right when the VM service starts listening - not
// necessarily right when it's ready to service RPC calls. That gap is normally sub-second, but
// on a slower/real device it can occasionally outlast a single connection attempt, so a handful
// of quick retries here absorbs the race without needing 'maxRetryCount'/'retryBackoffTime'
// (which only govern waiting for the log line itself, not this connection).
const socketConnectRetryCount = 5;
const socketConnectRetryIntervalMs = 1000;

// SOCKETS
/**
 * Opens an isolate socket for the given Flutter observatory URL, retrying a few times to absorb
 * the brief window right after the VM service starts listening where it isn't reliably
 * connectable yet.
 */
export async function connectSocket(
  this: FlutterDriver,
  dartObservatoryURL: string,
  caps: Record<string, any>,
): Promise<IsolateSocket> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= socketConnectRetryCount; attempt++) {
    try {
      return await attemptConnectSocket.bind(this)(dartObservatoryURL, caps);
    } catch (e) {
      lastError = e as Error;
      if (attempt < socketConnectRetryCount) {
        this.log.debug(
          `Attempt ${attempt}/${socketConnectRetryCount} to connect to the Dart Observatory failed, ` +
            `retrying in ${socketConnectRetryIntervalMs}ms: ${lastError.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, socketConnectRetryIntervalMs));
      }
    }
  }
  throw lastError;
}

async function attemptConnectSocket(
  this: FlutterDriver,
  dartObservatoryURL: string,
  caps: Record<string, any>,
): Promise<IsolateSocket> {
  const isolateId = caps.isolateId;

  this.log.debug(`Establishing a connection to the Dart Observatory`);

  const connectedPromise = new Promise<IsolateSocket | null>((resolve) => {
    const socket = new IsolateSocket(dartObservatoryURL);

    const removeListenerAndResolve = (r: IsolateSocket | null) => {
      socket.removeListener(`error`, onErrorListener);
      socket.removeListener(`timeout`, onTimeoutListener);
      socket.removeListener(`open`, onOpenListener);
      resolve(r);
    };

    // Add an 'error' event handler for the client socket
    const onErrorListener = (ex: Error) => {
      this.log.error(`Connection to ${dartObservatoryURL} got an error: ${ex.message}`);
      removeListenerAndResolve(null);
    };
    socket.on(`error`, onErrorListener);
    // Add a 'close' event handler for the client socket
    socket.on(`close`, () => {
      this.log.info(`Connection to ${dartObservatoryURL} closed`);
      // @todo do we need to set this.socket = null?
    });
    // Add a 'timeout' event handler for the client socket
    const onTimeoutListener = () => {
      this.log.error(`Connection to ${dartObservatoryURL} timed out`);
      removeListenerAndResolve(null);
    };
    socket.on(`timeout`, onTimeoutListener);
    const onOpenListener = async () => {
      const originalSocketCall = socket.call;
      socket.call = async (...args: any) => {
        try {
          // `await` is needed so that rejected promise will be thrown and caught
          return await originalSocketCall.apply(socket, args);
        } catch (e) {
          this.log.errorWithException(new Error(JSON.stringify(e)));
          // Re-throw (rather than resolving to undefined) so callers see the real failure
          // (e.g. a VM service RPC error) instead of a confusing secondary TypeError from
          // dereferencing an undefined result
          throw e;
        }
      };
      this.log.info(`Connecting to Dart Observatory: ${dartObservatoryURL}`);

      if (isolateId) {
        this.log.info(`Listing the given isolate id: ${isolateId}`);
        socket.isolateId = isolateId;
      } else {
        const vm = (await socket.call(`getVM`)) as {
          isolates: [
            {
              name: string;
              id: number;
            },
          ];
        };
        this.log.info(`Listing all isolates: ${JSON.stringify(vm.isolates)}`);
        // To accept 'main.dart:main()' and 'main'
        const mainIsolateCandidates = vm.isolates.filter((e) => e.name.includes(`main`));
        if (mainIsolateCandidates.length === 0) {
          this.log.error(`Cannot get Dart main isolate info`);
          removeListenerAndResolve(null);
          socket.close();
          return;
        }
        // More than one 'main'-named isolate can exist (e.g. a plugin running its own
        // secondary Flutter engine) - only one of them may actually have the flutter_driver
        // extension registered, so probe each candidate instead of assuming the first one
        // (previously picked unconditionally) is the app's real UI isolate.
        let selectedIsolateId: string | number | undefined;
        for (const candidate of mainIsolateCandidates) {
          const candidateIsolate = (await socket.call(`getIsolate`, {
            isolateId: `${candidate.id}`,
          })) as {extensionRPCs: [string] | null} | null;
          if (
            candidateIsolate &&
            Array.isArray(candidateIsolate.extensionRPCs) &&
            candidateIsolate.extensionRPCs.includes(`ext.flutter.driver`)
          ) {
            selectedIsolateId = candidate.id;
            break;
          }
        }
        // None of the 'main' isolates have the extension registered yet - fall back to the
        // first candidate so the retry-with-error-message loop below still applies as before.
        // e.g. 'isolates/2978358234363215', '2978358234363215'
        socket.isolateId = selectedIsolateId ?? mainIsolateCandidates[0].id;
      }

      // It could take time to load the expected module.
      try {
        await retryInterval(moduleCheckIntervalCount, moduleCheckIntervalMs, async () => {
          const isolate = (await socket.call(`getIsolate`, {
            isolateId: `${socket.isolateId}`,
          })) as {
            extensionRPCs: [string] | null;
          } | null;
          if (!isolate) {
            throw new Error(`Cannot get main Dart Isolate`);
          }
          if (!Array.isArray(isolate.extensionRPCs)) {
            throw new Error(`Cannot get Dart extensionRPCs from isolate ${JSON.stringify(isolate)}`);
          }
          if (isolate.extensionRPCs.indexOf(`ext.flutter.driver`) < 0) {
            throw new Error(
              `"ext.flutter.driver" is not found in "extensionRPCs" ${JSON.stringify(isolate.extensionRPCs)}`,
            );
          }
        });
      } catch (e) {
        this.log.error(e.message);
        removeListenerAndResolve(null);
        return;
      }
      removeListenerAndResolve(socket);
    };
    socket.on(`open`, onOpenListener);
  });

  const connectedSocket = await connectedPromise;
  if (connectedSocket) {
    return connectedSocket;
  }

  throw new Error(
    `Cannot connect to the Dart Observatory URL ${dartObservatoryURL}. Check the server log for more details`,
  );
}

/**
 * Fetches isolate metadata from the connected Flutter VM service.
 */
export async function executeGetIsolateCommand(this: FlutterDriver, isolateId: string | number) {
  this.log.debug(`>>> getIsolate`);
  const isolate = await (this.socket as IsolateSocket).call(`getIsolate`, {
    isolateId: `${isolateId}`,
  });
  this.log.debug(`<<< ${_.truncate(JSON.stringify(isolate), {length: truncateLength})}`);
  return isolate;
}

/**
 * Fetches VM metadata from the connected Flutter VM service.
 */
export async function executeGetVMCommand(this: FlutterDriver) {
  this.log.debug(`>>> getVM`);
  const vm = (await (this.socket as IsolateSocket).call(`getVM`)) as {
    isolates: [
      {
        name: string;
        id: number;
      },
    ];
  };
  this.log.debug(`<<< ${_.truncate(JSON.stringify(vm), {length: truncateLength})}`);
  return vm;
}

/**
 * Executes an element command through the connected Flutter isolate socket.
 */
export async function executeElementCommand(
  this: FlutterDriver,
  command: string,
  elementBase64?: string,
  extraArgs = {},
) {
  const elementObject = elementBase64 ? JSON.parse(decode(elementBase64)) : {};
  const serializedCommand = {command, ...elementObject, ...extraArgs};
  this.log.debug(`>>> ${JSON.stringify(serializedCommand)}`);
  const data = await (this.socket as IsolateSocket).executeSocketCommand(serializedCommand);
  this.log.debug(`<<< ${JSON.stringify(data)} | previous command ${command}`);
  if (data.isError) {
    throw new Error(`Cannot execute command ${command}, server response ${JSON.stringify(data, null, 2)}`);
  }
  return data.response;
}

/**
 * Extracts the Flutter observatory URL from a device log entry.
 */
export function extractObservatoryUrl(logEntry: LogEntry): URL | null {
  const match = logEntry.message.match(OBSERVATORY_URL_PATTERN);
  if (!match) {
    return null;
  }

  try {
    const result = new URL(match[2]);
    result.protocol = `ws`;
    result.pathname += `ws`;
    return result;
  } catch {
    return null;
  }
}
