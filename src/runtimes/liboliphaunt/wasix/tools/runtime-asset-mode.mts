const manifest = await Bun.file('target/oliphaunt-wasix/assets/manifest.json').json();
const present = (value) =>
  value !== null &&
  value !== undefined &&
  value !== false &&
  (!Array.isArray(value) || value.length > 0) &&
  (typeof value !== 'string' || value.length > 0) &&
  (typeof value !== 'number' || value !== 0) &&
  (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0);
console.log(
  present(manifest.extensions) && present(manifest['pg-dump']) && present(manifest.psql)
    ? 'full'
    : 'core',
);
