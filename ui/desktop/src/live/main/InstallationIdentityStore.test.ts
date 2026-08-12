import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallationIdentityStore } from './InstallationIdentityStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obelus-installation-identity-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('InstallationIdentityStore', () => {
  it('creates one stable, URL-safe identity in isolated Obelus storage', async () => {
    const directory = await temporaryDirectory();
    const store = new InstallationIdentityStore(directory);
    const first = await store.getOrCreateDeviceId();
    const second = await new InstallationIdentityStore(directory).getOrCreateDeviceId();

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9._~-]{16,128}$/);
    const persisted = JSON.parse(
      await readFile(path.join(directory, 'identity', 'installation.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(persisted).toEqual({ version: 1, deviceId: first });
  });

  it('fails closed instead of replacing a malformed existing identity', async () => {
    const directory = await temporaryDirectory();
    const identityDirectory = path.join(directory, 'identity');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(identityDirectory));
    const file = path.join(identityDirectory, 'installation.json');
    await writeFile(file, '{"version":1,"deviceId":"too-short"}\n');

    await expect(new InstallationIdentityStore(directory).getOrCreateDeviceId()).rejects.toThrow(
      'installation identity is invalid'
    );
    expect(await readFile(file, 'utf8')).toContain('too-short');
  });
});
