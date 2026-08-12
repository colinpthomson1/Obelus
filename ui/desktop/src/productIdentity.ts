import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PRODUCT_NAME = 'Obelus';
export const PRODUCT_PROTOCOL = 'obelus';
export const PRODUCT_DEEP_LINK_PREFIX = `${PRODUCT_PROTOCOL}://`;
export const PRODUCT_APP_ID = 'com.colinpthomson.obelus';

const obelusUserDataPath = path.join(app.getPath('appData'), PRODUCT_NAME);
const localAdHocBuild = path.join(process.resourcesPath, 'local-adhoc-build');
export const IS_LOCAL_ADHOC_BUILD = process.platform === 'darwin' && existsSync(localAdHocBuild);

if (IS_LOCAL_ADHOC_BUILD) {
  // Ad-hoc signatures do not have a stable Apple Team ID, so Chromium cannot safely
  // reuse its production Keychain ACL across local rebuilds.
  app.commandLine.appendSwitch('use-mock-keychain');
}

app.setName(PRODUCT_NAME);
app.setPath('userData', obelusUserDataPath);
app.setAppUserModelId(PRODUCT_APP_ID);

if (!process.env.GOOSE_PATH_ROOT?.trim()) {
  process.env.GOOSE_PATH_ROOT = path.join(obelusUserDataPath, 'backend');
}

process.env.GOOSE_KEYRING_SERVICE = 'obelus';
process.env.GOOSE_TELEMETRY_OFF = 'true';
