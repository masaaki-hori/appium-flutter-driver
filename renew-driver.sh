#!/bin/sh
appium driver uninstall flutter 
npm install
npm run build
appium driver install --source local /Volumes/Projects/VSCodeProjects/cygnus/appium/appium-flutter-driver/driver 2>&1
