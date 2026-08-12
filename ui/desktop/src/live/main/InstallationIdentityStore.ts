import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1_024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

interface InstallationIdentityRecord {
  version: typeof STORE_VERSION;
  deviceId: string;
}

export class InstallationIdentityStore {
  private readonly directory: string;
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'identity');
    this.filePath = path.join(this.directory, 'installation.json');
  }

  async getOrCreateDeviceId(): Promise<string> {
    const existing = await this.readExisting();
    if (existing) return existing;

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deviceId = randomBytes(32).toString('base64url');
    const record: InstallationIdentityRecord = { version: STORE_VERSION, deviceId };
    let handle;
    try {
      handle = await open(this.filePath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      await handle.sync();
      return deviceId;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') {
        const raced = await this.readExisting();
        if (raced) return raced;
      }
      throw new Error('Obelus could not persist its installation identity');
    } finally {
      await handle?.close();
    }
  }

  private async readExisting(): Promise<string | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw new Error('Obelus could not read its installation identity');
    }
    if (Buffer.byteLength(contents) > MAX_STORE_BYTES) {
      throw new Error('The Obelus installation identity is invalid');
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error('The Obelus installation identity is invalid');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      (value as Record<string, unknown>).version !== STORE_VERSION ||
      typeof (value as Record<string, unknown>).deviceId !== 'string' ||
      !DEVICE_ID_PATTERN.test((value as Record<string, string>).deviceId)
    ) {
      throw new Error('The Obelus installation identity is invalid');
    }
    return (value as InstallationIdentityRecord).deviceId;
  }
}
