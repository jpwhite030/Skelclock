/**
 * Metro configuration.
 *
 * Two things the default config does not know about this repo:
 *
 * 1. It is an npm workspace. The app's dependencies are hoisted to the repo
 *    root, and @skelclock/core lives outside the app directory entirely, so
 *    Metro has to watch the workspace root and look for modules there.
 *
 * 2. The workspace packages ship TypeScript source rather than a build step,
 *    and use ESM-style specifiers ('./types.js') that actually resolve to .ts
 *    files. Node's ESM loader and tsx both require that spelling. Next solves
 *    it with resolve.extensionAlias (see apps/web/next.config.mjs); Metro has
 *    no such option, so the rewrite is done here.
 */

const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const packagesRoot = path.join(workspaceRoot, 'packages');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Captured before reassignment: this is Expo's resolver, not the one below.
const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;

  // Scoped to the workspace packages on purpose. Plenty of modules under
  // node_modules import a relative '.js' that really is a .js file, and
  // speculatively probing for a .ts sibling on every one of those would be
  // both slower and a way to resolve something unintended.
  const fromWorkspacePackage = context.originModulePath?.startsWith(packagesRoot);

  if (fromWorkspacePackage && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    const base = moduleName.slice(0, -'.js'.length);
    for (const extension of ['.ts', '.tsx']) {
      try {
        return resolve(context, base + extension, platform);
      } catch {
        // Not that extension; fall through to the next, then to the original.
      }
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;
