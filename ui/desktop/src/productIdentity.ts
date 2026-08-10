import { app } from 'electron';
import path from 'node:path';

export const PRODUCT_NAME = 'Obelus';
export const PRODUCT_PROTOCOL = 'obelus';
export const PRODUCT_DEEP_LINK_PREFIX = `${PRODUCT_PROTOCOL}://`;
export const PRODUCT_APP_ID = 'com.colinpthomson.obelus';

const obelusUserDataPath = path.join(app.getPath('appData'), PRODUCT_NAME);

app.setName(PRODUCT_NAME);
app.setPath('userData', obelusUserDataPath);
app.setAppUserModelId(PRODUCT_APP_ID);

if (!process.env.GOOSE_PATH_ROOT?.trim()) {
  process.env.GOOSE_PATH_ROOT = path.join(obelusUserDataPath, 'backend');
}

process.env.GOOSE_KEYRING_SERVICE = 'obelus';
process.env.GOOSE_TELEMETRY_OFF = 'true';
