import type {FlutterDriver} from '../driver';
import type {IsolateSocket} from '../sessions/isolate_socket';

// Uses flutter_driver's own `screenshot` command (via `ext.flutter.driver`, same channel as
// tap/scroll/enter_text) rather than the engine's raw `_flutter.screenshot` VM-service RPC.
//
// The raw RPC (Shell::OnServiceProtocolScreenshot in shell/common/shell.cc) always requests a
// *compressed* (PNG) image, but Impeller's screenshot path explicitly refuses to compress
// (ScreenshotLayerTreeAsImageImpeller in shell/common/rasterizer.cc bails out immediately with
// "Compressed screenshots not supported for Impeller" whenever `compressed` is true), so the raw
// RPC fails with `{"code":-32000,"message":"Could not capture image screenshot."}` on every
// Android device/emulator, since Impeller is the default renderer there since API 29
// (kMinimumAndroidApiLevelForImpeller in shell/platform/android/flutter_main.cc) unless the
// app-under-test explicitly opts out.
//
// flutter_driver's own `screenshot` command (handler_factory.dart#_takeScreenshot) takes a
// different, Impeller-agnostic path: it grabs the root `OffsetLayer` and calls `Layer.toImage()`
// (the same Dart-level API `RepaintBoundary.toImage()` uses), then PNG-encodes the result in Dart
// via `Image.toByteData(format: ImageByteFormat.png)` - none of which goes through the engine's
// compressed-screenshot restriction. This command needs no app-side changes: it's part of
// flutter_driver's `CommandHandlerFactory` base, which `AppiumHandlerDriverExtension` (see
// appium-handler's `appium_handler_extension.dart`) already inherits.
export const getScreenshot = async function (this: FlutterDriver) {
  const response = (await (this.socket as IsolateSocket).executeSocketCommand({
    command: `screenshot`,
    format: `4`, // ScreenshotFormat.png - see packages/flutter_driver/lib/src/common/screenshot.dart
  })) as any;
  return response.response.data;
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
