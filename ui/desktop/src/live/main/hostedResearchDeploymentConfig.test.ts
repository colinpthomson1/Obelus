import { describe, expect, it } from 'vitest';
import {
  OBELUS_STAGING_PUBLIC_CONFIG,
  resolveHostedResearchDeploymentConfig,
} from './hostedResearchDeploymentConfig';

describe('hosted research deployment configuration', () => {
  it('uses the public staging configuration when runtime overrides are absent', () => {
    expect(resolveHostedResearchDeploymentConfig({}, { isPackaged: false })).toEqual({
      gatewayUrl: OBELUS_STAGING_PUBLIC_CONFIG.gatewayUrl,
      identityEnvironment: {
        OBELUS_AUTH0_ISSUER: OBELUS_STAGING_PUBLIC_CONFIG.auth0Issuer,
        OBELUS_AUTH0_CLIENT_ID: OBELUS_STAGING_PUBLIC_CONFIG.auth0ClientId,
        OBELUS_AUTH0_AUDIENCE: OBELUS_STAGING_PUBLIC_CONFIG.auth0Audience,
      },
    });
  });

  it('prefers trimmed runtime overrides for development and test launches', () => {
    expect(
      resolveHostedResearchDeploymentConfig(
        {
          OBELUS_GATEWAY_URL: ' http://127.0.0.1:8787 ',
          OBELUS_AUTH0_ISSUER: ' https://identity.test.example/ ',
          OBELUS_AUTH0_CLIENT_ID: ' test-native-client ',
          OBELUS_AUTH0_AUDIENCE: ' urn:obelus:test:gateway ',
        },
        { isPackaged: false }
      )
    ).toEqual({
      gatewayUrl: 'http://127.0.0.1:8787',
      identityEnvironment: {
        OBELUS_AUTH0_ISSUER: 'https://identity.test.example/',
        OBELUS_AUTH0_CLIENT_ID: 'test-native-client',
        OBELUS_AUTH0_AUDIENCE: 'urn:obelus:test:gateway',
      },
    });
  });

  it('ignores hostile runtime gateway and Auth0 overrides in packaged builds', () => {
    expect(
      resolveHostedResearchDeploymentConfig(
        {
          OBELUS_GATEWAY_URL: 'https://attacker.example/gateway',
          OBELUS_AUTH0_ISSUER: 'https://attacker.example/',
          OBELUS_AUTH0_CLIENT_ID: 'attacker-client',
          OBELUS_AUTH0_AUDIENCE: 'urn:attacker:gateway',
        },
        { isPackaged: true }
      )
    ).toEqual({
      gatewayUrl: OBELUS_STAGING_PUBLIC_CONFIG.gatewayUrl,
      identityEnvironment: {
        OBELUS_AUTH0_ISSUER: OBELUS_STAGING_PUBLIC_CONFIG.auth0Issuer,
        OBELUS_AUTH0_CLIENT_ID: OBELUS_STAGING_PUBLIC_CONFIG.auth0ClientId,
        OBELUS_AUTH0_AUDIENCE: OBELUS_STAGING_PUBLIC_CONFIG.auth0Audience,
      },
    });
  });

  it('does not let blank runtime values erase bundled public configuration', () => {
    expect(
      resolveHostedResearchDeploymentConfig(
        {
          OBELUS_GATEWAY_URL: ' ',
          OBELUS_AUTH0_ISSUER: '\t',
          OBELUS_AUTH0_CLIENT_ID: '',
          OBELUS_AUTH0_AUDIENCE: '\n',
        },
        { isPackaged: false }
      )
    ).toEqual({
      gatewayUrl: OBELUS_STAGING_PUBLIC_CONFIG.gatewayUrl,
      identityEnvironment: {
        OBELUS_AUTH0_ISSUER: OBELUS_STAGING_PUBLIC_CONFIG.auth0Issuer,
        OBELUS_AUTH0_CLIENT_ID: OBELUS_STAGING_PUBLIC_CONFIG.auth0ClientId,
        OBELUS_AUTH0_AUDIENCE: OBELUS_STAGING_PUBLIC_CONFIG.auth0Audience,
      },
    });
  });
});
