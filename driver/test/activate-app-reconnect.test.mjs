import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {it} from 'node:test';

import {FlutterDriver} from '../build/lib/driver.js';
import {LogMonitor} from '../build/lib/sessions/log-monitor.js';

const noopLog = {info() {}, debug() {}, warn() {}, error() {}, errorWithException() {}};
const vmLine = (port) => ({
  timestamp: Date.now(),
  level: 'info',
  message: `flutter: The Dart VM service is listening on http://127.0.0.1:${port}/abc=/`,
});

// `launchedLine` is what the app logs while the proxy driver is still launching it (iOS: WDA waits
// for the app to idle before it returns). The reconnect stops at isRealDevice(), right after the
// observatory URL has been read from the log.
async function fakeDriver(launchedLine) {
  const syslog = new EventEmitter();
  const logmon = new LogMonitor(syslog, async (entry) => entry.message.includes('Dart VM service')).start();
  syslog.emit('output', vmLine(50000)); // the app before it was terminated
  await new Promise((resolve) => setImmediate(resolve)); // LogMonitor records matches asynchronously
  return {
    log: noopLog,
    _logmon: logmon,
    internalCaps: {platformName: 'iOS', maxRetryCount: 1, retryBackoffTime: 10},
    proxydriver: {
      activateApp: async () => {
        if (launchedLine) {
          syslog.emit('output', launchedLine);
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
      isRealDevice: () => {
        throw new Error('observatory URL found');
      },
    },
  };
}

it('activateApp uses the VM service URL logged while the app was being launched', async () => {
  const driver = await fakeDriver(vmLine(50001));

  await assert.rejects(FlutterDriver.prototype.activateApp.call(driver, 'com.example.app'), /observatory URL found/);
  assert.match(driver._logmon.lastMatch.message, /:50001\//);
});

it('activateApp does not reuse the URL of the app from before the launch', async () => {
  const driver = await fakeDriver(null);

  await assert.rejects(FlutterDriver.prototype.activateApp.call(driver, 'com.example.app'), /No observatory URL/);
});
