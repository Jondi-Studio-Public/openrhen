#!/usr/bin/env bash
# Builds the unsigned OpenRhen-unsigned.ipa from mobile/ios on a Mac with Xcode. CI's `iOS app` job runs it.
set -euo pipefail
cd "$(dirname "$0")"

xcodebuild -version
# The pure files (Foundation only): URL rules, QR payload, request/response contract, device-code poll loop, ping outbox,
# sign-in state, the client view types, cache and presentation words, the command outbox and the session flow. The checks
# decode every fixture in platform/contracts/client-view-fixtures.v1.json with the Swift types and fail on a mismatch.
swiftc Sources/HostPolicy.swift Sources/Policies.swift Sources/PairingPayload.swift Sources/CredentialStore.swift \
  Sources/ApiContract.swift Sources/DeviceCodePoller.swift Sources/PingOutbox.swift Sources/AuthState.swift \
  Sources/ClientView.swift Sources/LocalFiles.swift Sources/ViewCache.swift Sources/ViewPresentation.swift \
  Sources/CommandContract.swift Sources/CommandOutbox.swift Sources/SessionFlow.swift \
  Checks/main.swift -o host-policy-checks
./host-policy-checks ../../platform/contracts/client-view-fixtures.v1.json ../../platform/contracts/client-view-schema.v1.json
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
