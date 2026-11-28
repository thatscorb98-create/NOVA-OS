// Point the generated Android release build at the repository keystore.
//
// `expo prebuild` generates android/app/build.gradle with the release build
// signed by the template debug key, which changes on every CI runner. This
// script adds a release signingConfig that reads the keystore from the
// environment, so every build carries the same certificate and a new APK
// installs over the previous one.
//
// Run after `expo prebuild` and before `gradlew assembleRelease`.

import { readFileSync, writeFileSync } from 'node:fs';

const gradlePath = 'android/app/build.gradle';
const required = [
  'NOVA_KEYSTORE_PATH',
  'NOVA_KEYSTORE_PASSWORD',
  'NOVA_KEY_ALIAS',
  'NOVA_KEY_PASSWORD',
];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.error(`Missing signing environment: ${missing.join(', ')}`);
  process.exit(1);
}

let gradle = readFileSync(gradlePath, 'utf8');

if (!gradle.includes('signingConfigs.release')) {
  const anchor = 'signingConfigs {';
  if (!gradle.includes(anchor)) {
    console.error(`Could not find "${anchor}" in ${gradlePath}`);
    process.exit(1);
  }

  const releaseConfig = `${anchor}
        release {
            storeFile file(System.getenv('NOVA_KEYSTORE_PATH'))
            storeType 'pkcs12'
            storePassword System.getenv('NOVA_KEYSTORE_PASSWORD')
            keyAlias System.getenv('NOVA_KEY_ALIAS')
            keyPassword System.getenv('NOVA_KEY_PASSWORD')
        }`;

  gradle = gradle.replace(anchor, releaseConfig);
}

const releaseBuildType = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;

if (releaseBuildType.test(gradle)) {
  gradle = gradle.replace(releaseBuildType, '$1signingConfig signingConfigs.release');
} else if (!/buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?signingConfig signingConfigs\.release/.test(gradle)) {
  console.error(`Could not point the release build type at the signing config in ${gradlePath}`);
  process.exit(1);
}

writeFileSync(gradlePath, gradle);
console.log('Release signing configured with the repository keystore.');
