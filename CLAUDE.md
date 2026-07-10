# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This is the **appium-flutter-driver** monorepo: an Appium driver that automates Flutter apps by
speaking the Dart VM Service Protocol (`ext.flutter.driver` extension), the same protocol used by
Flutter's own `flutter_driver` package. It is not a single package — it's split into independently
versioned/published sub-projects:

- `driver/` — the actual Appium driver (TypeScript/Node.js, npm package `appium-flutter-driver`).
  This is where almost all engineering work happens.
- `finder/` — client-side "finder" helper libraries in multiple languages (nodejs, python, ruby,
  kotlin, dotnet) that build the JSON payloads (`byValueKey`, `byText`, etc.) sent to the driver.
  Each has its own package manifest/build and is published separately.
- `example/` — sample Flutter app-under-test plus example client scripts in several languages
  (nodejs, python, ruby, java) used for manual and CI end-to-end testing.

Only `driver/**` and `finder/**` changes trigger their respective CI workflows (see path filters in
`.github/workflows/`).

## Common commands

All driver commands are run from the `driver/` directory (it has its own `package.json`; there is
no root package.json).

```
cd driver
npm install
npm run build          # tsc -b, compiles TS to build/
npm run dev             # build --watch
npm run lint             # eslint .
npm run lint:fix
npm run format           # prettier -w ./lib
npm run format:check     # used in CI
npm run clean            # tsc -b --clean
```

There is no unit test suite for the driver (`npm test` is a no-op — `echo no test`). Correctness is
instead verified by:
- CI type-check/lint/format (`nodejs.yml`)
- End-to-end functional runs against a real emulator/simulator + a real Flutter app-under-test
  (`driver-function.yml`), driven by the Ruby example scripts in `example/ruby/`.

To install a local build into a local Appium server for manual testing:

```
appium driver install --source=local driver
appium driver doctor flutter        # validate environment (Android + iOS)
SKIP_ANDROID=1 appium driver doctor flutter   # skip Android checks
SKIP_IOS=1 appium driver doctor flutter       # skip iOS checks
```

### Finder sub-packages

Each finder implementation manages its own toolchain independently:
- `finder/nodejs`: `npm run compile` (tsc), `npm test` (mocha), `npm run lint` (tslint)
- `finder/python`: standard `setup.py`, linted with pylint (`.pylintrc`)
- `finder/kotlin`: Gradle project (`./gradlew`), published via JitPack (`jitpack.yml` builds this)
- `finder/dotnet`: `DotNetAppiumFlutterFinder.sln`

### Release process (driver)

```
cd driver
sh release.sh
npm version <major|minor|patch>
# update changelog
git commit -am 'chore: bump version'
git tag <version>       # e.g. v0.0.32
git push origin <version>
git push origin main
```
Then the `publish.yml` GitHub Actions workflow publishes to npm (this is a real, remote-affecting
action — do not trigger it without explicit user instruction).

## Architecture (driver/)

The driver extends Appium's `BaseDriver` and internally **wraps and proxies to another full Appium
driver** (`appium-uiautomator2-driver` on Android, `appium-xcuitest-driver` on iOS) rather than
reimplementing native automation itself.

- `lib/driver.ts` — `FlutterDriver` class, the entry point (`mainClass` in `driver/package.json`'s
  `appium` config). Holds `this.proxydriver` (the wrapped UIA2/XCUITest driver instance) and
  `this.socket` (the `IsolateSocket` connection to the Dart VM Service). Overrides
  `createSession`/`deleteSession`/`executeCommand`/`proxyCommand`/`getProxyAvoidList` etc. to decide,
  per-command, whether to handle it directly (Flutter context) or forward it to `proxydriver`
  (native/webview context).

- **Three contexts** (`lib/commands/context.ts`), switched via the standard Appium
  `setContext`/`getContexts` W3C commands:
  - `FLUTTER` — commands go straight to the Dart VM over the observatory/VM-service WebSocket.
    Native page source is unavailable in this context (use `getRenderTree` instead).
  - `NATIVE_APP` — proxied through to UIA2 (Android) or XCUITest (iOS), same as a plain
    Appium session.
  - `WEBVIEW_XXXX` — proxied to UIA2/XCUITest's webview handling (chromedriver on Android, XCUITest
    on iOS). `driverShouldDoProxyCmd()` and `getProxyAvoidList()` decide which requests must NOT be
    proxied even in webview context (context/appium/orientation/log endpoints — see
    `WEBVIEW_NO_PROXY` in `driver.ts`).

- **Session bootstrapping** (`lib/sessions/session.ts`, `lib/sessions/android.ts`,
  `lib/sessions/ios.ts`): `createSession` starts the platform-specific proxy driver
  (`startAndroidSession`/`startIOSSession`), which launches/attaches the app and establishes the
  `IsolateSocket` to the Dart VM. `reConnectFlutterDriver` re-establishes that socket after the
  app-under-test's process changes (e.g. after `activateApp`, `mobile:activateApp`, or
  `flutter:launchApp`) — required because a new process means a new VM Service endpoint.

- **Talking to the Dart VM** (`lib/sessions/observatory.ts`, `lib/sessions/isolate_socket.ts`):
  `IsolateSocket` wraps the raw RPC WebSocket (`rpc-websockets`) connection to the Dart VM Service.
  `executeElementCommand`/`executeGetVMCommand`/`executeGetIsolateCommand` send JSON-RPC requests
  matching the `flutter_driver` wire protocol (`get_health`, `get_render_tree`, `tap`, `waitFor`,
  etc.).

- **Command dispatch** (`lib/commands/execute.ts`): all `flutter:*` / `mobile:*` execute-script
  commands are routed here through a `commandHandlers` map keyed by command name (stripped of the
  `flutter:` prefix via `flutterCommandRegex`). Widget-scoped commands (`getText`, `tap`, `scroll*`,
  `waitFor*`, `getBottomLeft`, etc.) take a Flutter finder payload and forward it to the Dart VM;
  session-scoped commands (`checkHealth`, `getVMInfo`, `setIsolateId`, etc.) operate on the whole
  connection. Related widget-command groups live in `lib/commands/execute/scroll.ts` and
  `lib/commands/execute/wait.ts`; visibility assertions (`assertVisible`, `assertNotVisible`,
  `assertTappable`) live in `lib/commands/assertions.ts`.

- **Command extensions**: `dragAndDropWithCommandExtension` and `getTextWithCommandExtension` are
  Dart-side `CommandExtension`s (not built into `flutter_driver` itself). Sample Dart implementations
  the app-under-test must copy into its own `lib/` folder live in `example/dart/`
  (`drag_commands.dart`, `get_text_command.dart`) and must be registered in the app's
  `enableFlutterDriverExtension(commands: [...])` call.

- `lib/doctor/` — implements the `appium driver doctor flutter` checks (declared via
  `appium.doctor.checks` in `driver/package.json`).
- `lib/desired-caps.ts` — capability schema/constraints (`retryBackoffTime`, `maxRetryCount`,
  `observatoryWsUri`, `isolateId`, `skipPortForward`, `remoteAdbHost`, `adbPort`,
  `forwardingPort`, `dartVmServicePort`, etc. — see README "Capabilities" section for the
  authoritative description of each).

## Key constraints to keep in mind

- The app-under-test must be built in `debug` or `profile` mode and depend on `flutter_driver`
  (release-mode/production apps can't be driven this way).
- `FLUTTER` context has no page source support (`getRenderTree` is the substitute) and doesn't work
  with Appium Inspector.
- Any change that affects app process/VM-service reattachment (`activateApp`, `installApp`,
  `flutter:launchApp`, `mobile:activateApp`) must go through `reConnectFlutterDriver` — don't bypass
  it or the socket will point at a stale Dart VM Service instance.
- `driver/npm-shrinkwrap.json` is committed — prefer `npm install` (respecting the shrinkwrap) over
  actions that would regenerate it unnecessarily.
- Peer dependency is `appium ^3.0.0`; Node engines are constrained to `^20.19.0 || ^22.12.0 ||
  >=24.0.0` (see `driver/package.json`).
