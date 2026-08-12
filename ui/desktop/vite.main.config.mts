import { defineConfig } from 'vite';
import { OBELUS_STAGING_PUBLIC_CONFIG } from './src/live/main/hostedResearchDeploymentConfig.ts';

const buildPublicValue = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GITHUB_OWNER': JSON.stringify(process.env.GITHUB_OWNER || 'colinpthomson1'),
    'process.env.GITHUB_REPO': JSON.stringify(process.env.GITHUB_REPO || 'Obelus'),
    'process.env.GOOSE_BUNDLE_NAME': JSON.stringify(process.env.GOOSE_BUNDLE_NAME || 'Obelus'),
    __OBELUS_PUBLIC_GATEWAY_URL__: JSON.stringify(
      buildPublicValue('OBELUS_BUILD_GATEWAY_URL', OBELUS_STAGING_PUBLIC_CONFIG.gatewayUrl)
    ),
    __OBELUS_PUBLIC_AUTH0_ISSUER__: JSON.stringify(
      buildPublicValue('OBELUS_BUILD_AUTH0_ISSUER', OBELUS_STAGING_PUBLIC_CONFIG.auth0Issuer)
    ),
    __OBELUS_PUBLIC_AUTH0_CLIENT_ID__: JSON.stringify(
      buildPublicValue('OBELUS_BUILD_AUTH0_CLIENT_ID', OBELUS_STAGING_PUBLIC_CONFIG.auth0ClientId)
    ),
    __OBELUS_PUBLIC_AUTH0_AUDIENCE__: JSON.stringify(
      buildPublicValue('OBELUS_BUILD_AUTH0_AUDIENCE', OBELUS_STAGING_PUBLIC_CONFIG.auth0Audience)
    ),
  },
});
