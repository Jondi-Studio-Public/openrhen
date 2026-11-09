#!/usr/bin/env bash
# Builds OpenRhen-Spike-unsigned.ipa (slice 0.5 signing spike). Throwaway: deleted once the spike is recorded.
set -euo pipefail
cd "$(dirname "$0")"
command -v xcodegen >/dev/null || brew install xcodegen
command -v ldid >/dev/null || brew install ldid
xcodegen generate
xcodebuild -project OpenRhenSpike.xcodeproj -scheme Spike -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
APP=build/Build/Products/Release-iphoneos/Spike.app
# An unsigned device build carries no entitlements, so the re-signing tool would see no groups to register.
# Pseudo-sign each bundle with the entitlements file (ldid) so they are present for Sideloadly to read.
for bundle in "$APP/PlugIns/SpikeWidget.appex" "$APP/PlugIns/SpikeShare.appex" "$APP"; do
  ldid -Sentitlements.plist "$bundle"
done
rm -rf Payload OpenRhen-Spike-unsigned.ipa
mkdir Payload
cp -R "$APP" Payload/
zip -qr OpenRhen-Spike-unsigned.ipa Payload
unzip -l OpenRhen-Spike-unsigned.ipa | grep -q 'PlugIns/SpikeWidget.appex/'
unzip -l OpenRhen-Spike-unsigned.ipa | grep -q 'PlugIns/SpikeShare.appex/'
echo "Built mobile/ios-spike/OpenRhen-Spike-unsigned.ipa"
