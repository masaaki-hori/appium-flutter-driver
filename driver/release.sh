#!/bin/sh
set -e

echo "refreshing dependencies"
rm -f npm-shrinkwrap.json
APPIUM_SKIP_CHROMEDRIVER_INSTALL=1 npm run clean-dependency
# skip lifecycle scripts: "prepare" runs tsc, which is only available as a dev dependency
npm install --omit=dev --ignore-scripts
npm prune --omit=dev --omit=peer
rm -rf node_modules/appium
npm shrinkwrap --omit=dev --omit=peer

# to install types again
npm install --no-package-lock

echo "complete the refreshment"
