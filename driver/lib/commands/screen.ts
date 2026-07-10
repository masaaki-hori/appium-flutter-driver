import type {FlutterDriver} from '../driver';
import type {IsolateSocket} from '../sessions/isolate_socket';

export const getScreenshot = async function (this: FlutterDriver) {
  const response = (await (this.socket as IsolateSocket).call(`_flutter.screenshot`)) as any;
  return response.screenshot;
};

// The below three commands exist to make Appium Inspector (and any other W3C-standard client)
// usable against the FLUTTER context. They forward to the app-under-test's `requestData` handler
// (see `flutter:requestData` in ./execute.ts), which must be backed by a Dart-side handler such as
// https://github.com/baleen-studio/appium-handler that knows how to answer 'getScreenSize',
// 'getPageSource' and 'performActions:<json>'.

export const getWindowRect = async function (this: FlutterDriver) {
  const response = (await this.execute(`flutter:requestData`, ['getScreenSize'])) as any;
  const {width, height} = JSON.parse(response.response.message);
  return {width, height, x: 0, y: 0};
};

export const getPageSource = async function (this: FlutterDriver) {
  const response = (await this.execute(`flutter:requestData`, ['getPageSource'])) as any;
  return response.response.message;
};

export const performActions = async function (this: FlutterDriver, actions: string | object) {
  const serializedActions = typeof actions === 'string' ? actions : JSON.stringify(actions);
  return await this.execute(`flutter:requestData`, [`performActions:${serializedActions}`]);
};
