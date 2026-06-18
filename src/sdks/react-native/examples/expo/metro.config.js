const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const appNodeModules = path.join(projectRoot, 'node_modules');

const config = getDefaultConfig(projectRoot);

config.watchFolders = Array.from(new Set([
  ...(config.watchFolders ?? []),
  workspaceRoot,
]));

config.resolver.nodeModulesPaths = [
  appNodeModules,
];

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  expo: path.join(appNodeModules, 'expo'),
  react: path.join(appNodeModules, 'react'),
  'react-native': path.join(appNodeModules, 'react-native'),
};

module.exports = config;
