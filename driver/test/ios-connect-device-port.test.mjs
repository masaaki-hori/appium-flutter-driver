import assert from 'node:assert/strict';
import {it} from 'node:test';

import {connectDevicePort} from '../build/lib/sessions/ios.js';

const UDID = '00008110-000000000000001E';
const entry = (DeviceID, ConnectionType, SerialNumber = UDID) => ({
  DeviceID,
  Properties: {DeviceID, ConnectionType, SerialNumber},
});

function fakeUsbmux(devices) {
  const calls = {connect: [], closed: false};
  return {
    calls,
    create: async () => ({
      listDevices: async () => devices,
      connect: async (deviceID, port) => {
        calls.connect.push([deviceID, port]);
        return {deviceID, port};
      },
      close: () => {
        calls.closed = true;
      },
    }),
  };
}

it('prefers the USB entry when the device is also listed over the network', async () => {
  const usbmux = fakeUsbmux([entry(4, 'Network'), entry(3, 'USB')]);
  await connectDevicePort(UDID, 50720, usbmux.create);
  assert.deepEqual(usbmux.calls.connect, [[3, 50720]]);
});

it('falls back to the first entry without a USB one', async () => {
  const usbmux = fakeUsbmux([entry(7, 'Network'), entry(9, 'USB', 'another-device')]);
  await connectDevicePort(UDID, 8181, usbmux.create);
  assert.deepEqual(usbmux.calls.connect, [[7, 8181]]);
});

it('fails and closes the client when the device is not listed', async () => {
  const usbmux = fakeUsbmux([entry(9, 'USB', 'another-device')]);
  await assert.rejects(connectDevicePort(UDID, 8181, usbmux.create), /Could not find the expected device/);
  assert.equal(usbmux.calls.closed, true);
});
