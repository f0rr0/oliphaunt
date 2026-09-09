const descriptor = require('./index.js');
const { pathToFileURL } = require('node:url');

module.exports = Object.freeze({
  ...descriptor,
  packageJsonUrl: pathToFileURL(require.resolve('./package.json')).href,
});
