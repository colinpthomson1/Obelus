import type { Auth0GatewayIdentityEnvironment } from './Auth0GatewayIdentityAdapter';

declare const __OBELUS_PUBLIC_GATEWAY_URL__: string | undefined;
declare const __OBELUS_PUBLIC_AUTH0_ISSUER__: string | undefined;
declare const __OBELUS_PUBLIC_AUTH0_CLIENT_ID__: string | undefined;
declare const __OBELUS_PUBLIC_AUTH0_AUDIENCE__: string | undefined;

export const OBELUS_STAGING_PUBLIC_CONFIG = Object.freeze({
  gatewayUrl: 'https://obelus-gateway-staging.onrender.com',
  auth0Issuer: 'https://dev-11haofehrxjv0lyx.us.auth0.com/',
  auth0ClientId: 'EUgCgX7CUfuaPMQ4ofLLSPOPutlVAedn',
  auth0Audience: 'urn:obelus:staging:gateway',
});

export interface HostedResearchDeploymentEnvironment extends Auth0GatewayIdentityEnvironment {
  OBELUS_GATEWAY_URL?: string;
}

export interface HostedResearchDeploymentConfig {
  gatewayUrl: string;
  identityEnvironment: Auth0GatewayIdentityEnvironment;
}

const bundledPublicConfig = Object.freeze({
  gatewayUrl:
    typeof __OBELUS_PUBLIC_GATEWAY_URL__ === 'string'
      ? __OBELUS_PUBLIC_GATEWAY_URL__
      : OBELUS_STAGING_PUBLIC_CONFIG.gatewayUrl,
  auth0Issuer:
    typeof __OBELUS_PUBLIC_AUTH0_ISSUER__ === 'string'
      ? __OBELUS_PUBLIC_AUTH0_ISSUER__
      : OBELUS_STAGING_PUBLIC_CONFIG.auth0Issuer,
  auth0ClientId:
    typeof __OBELUS_PUBLIC_AUTH0_CLIENT_ID__ === 'string'
      ? __OBELUS_PUBLIC_AUTH0_CLIENT_ID__
      : OBELUS_STAGING_PUBLIC_CONFIG.auth0ClientId,
  auth0Audience:
    typeof __OBELUS_PUBLIC_AUTH0_AUDIENCE__ === 'string'
      ? __OBELUS_PUBLIC_AUTH0_AUDIENCE__
      : OBELUS_STAGING_PUBLIC_CONFIG.auth0Audience,
});

export function resolveHostedResearchDeploymentConfig(
  environment: HostedResearchDeploymentEnvironment
): HostedResearchDeploymentConfig {
  return {
    gatewayUrl: configuredValue(environment.OBELUS_GATEWAY_URL, bundledPublicConfig.gatewayUrl),
    identityEnvironment: {
      OBELUS_AUTH0_ISSUER: configuredValue(
        environment.OBELUS_AUTH0_ISSUER,
        bundledPublicConfig.auth0Issuer
      ),
      OBELUS_AUTH0_CLIENT_ID: configuredValue(
        environment.OBELUS_AUTH0_CLIENT_ID,
        bundledPublicConfig.auth0ClientId
      ),
      OBELUS_AUTH0_AUDIENCE: configuredValue(
        environment.OBELUS_AUTH0_AUDIENCE,
        bundledPublicConfig.auth0Audience
      ),
    },
  };
}

function configuredValue(runtimeValue: string | undefined, bundledValue: string): string {
  return runtimeValue?.trim() || bundledValue.trim();
}
