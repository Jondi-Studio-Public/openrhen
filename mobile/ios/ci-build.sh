#!/usr/bin/env bash
# Builds the unsigned OpenRhen-unsigned.ipa from mobile/ios on a Mac with Xcode. CI's `iOS app` job runs it.
set -euo pipefail
cd "$(dirname "$0")"

xcodebuild -version
swiftc Sources/HostPolicy.swift Checks/main.swift -o host-policy-checks
./host-policy-checks
command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate
xcodebuild -project OpenRhen.xcodeproj -scheme OpenRhen -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
rm -rf Payload OpenRhen-unsigned.ipa
mkdir Payload
cp -R build/Build/Products/Release-iphoneos/OpenRhen.app Payload/
zip -qr OpenRhen-unsigned.ipa Payload
unzip -l OpenRhen-unsigned.ipa | grep -q 'Payload/OpenRhen.app/OpenRhen$'
unzip -p OpenRhen-unsigned.ipa Payload/OpenRhen.app/Info.plist > build/Info.plist
test "$(plutil -extract CFBundleIdentifier raw -o - build/Info.plist)" = "org.openrhen.app"
echo "Built mobile/ios/OpenRhen-unsigned.ipa"
