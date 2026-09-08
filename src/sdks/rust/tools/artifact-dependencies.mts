const metadata = await Bun.file(process.env.OLIPHAUNT_CARGO_METADATA).json();
for (const dependency of metadata.packages[0].dependencies) {
  if (
    dependency.name.startsWith('liboliphaunt-native-') ||
    dependency.name.startsWith('oliphaunt-broker-')
  ) {
    const version = dependency.req.match(/^=([0-9A-Za-z.+-]+)$/)?.[1];
    if (!version)
      throw new Error(`artifact dependency ${dependency.name} must use an exact version`);
    console.log(`${dependency.name}\t${version}`);
  }
}
