import * as fs from 'node:fs';
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'receipt': {
    const metadata = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const extensions = (metadata.extensions ?? []).map((row) => row['sql-name']).sort();
    process.stdout.write(
      JSON.stringify({
        schema: 'oliphaunt-expo-smoke-pass-v4',
        runner: 'smoke',
        platform: 'ios',
        extensionCount: extensions.length,
        allExtensionsActivated: true,
        extensionCatalogComplete: true,
        pgTextsearchEnglishBm25: extensions.includes('pg_textsearch'),
        extensionCatalogSha256: metadata['extension-catalog-sha256'],
        catalogProfile: 'standard',
        icuRuntimeProof: false,
      }),
    );
    break;
  }
  case 'tamper': {
    const file = args[0];
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    receipt.candidateTree = '0'.repeat(40);
    fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
    break;
  }
  default:
    throw Error('unknown mobile runner fixture command');
}
