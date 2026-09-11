switch (Bun.argv[2]) {
  case 'selection': {
    const manifest = JSON.parse(await Bun.file(process.env.IOS_CARRIER_MANIFEST).text());
    const planned = String(process.env.PLANNED_EXTENSION_SQL_NAMES ?? '')
      .split(',')
      .filter(Boolean)
      .sort();
    if (planned.length === 0) {
      throw new Error('planner selected no exact iOS extension carriers');
    }
    if (!Array.isArray(manifest.extensions) || manifest.extensions.length === 0) {
      throw new Error('exact iOS carrier manifest contains no extensions');
    }
    const names = manifest.extensions.map((row) => row.sqlName).sort();
    if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
      throw new Error('exact iOS carrier manifest has invalid or duplicate extension identities');
    }
    if (JSON.stringify(names) !== JSON.stringify(planned)) {
      throw new Error(
        'exact iOS carrier manifest does not match the planner-selected extension set',
      );
    }
    process.stdout.write(names.join(','));

    break;
  }
  case 'verify': {
    const manifest = JSON.parse(await Bun.file(process.env.IOS_CARRIER_MANIFEST).text());
    const selection = JSON.parse(
      await Bun.file(process.env.IOS_CARRIER_STAGE + '/selection.json').text(),
    );
    const expected = String(process.env.PLANNED_EXTENSION_SQL_NAMES ?? '')
      .split(',')
      .filter(Boolean)
      .sort();
    const manifested = manifest.extensions.map((row) => row.sqlName).sort();
    const requested = [...selection.requestedExtensions].sort();
    const resolved = selection.extensions.map((row) => row.sqlName).sort();
    if (
      JSON.stringify(manifested) !== JSON.stringify(expected) ||
      !selection.icu ||
      JSON.stringify(requested) !== JSON.stringify(expected) ||
      JSON.stringify(resolved) !== JSON.stringify(expected)
    ) {
      throw new Error(
        'staged iOS carrier selection does not exactly cover every manifest extension plus ICU',
      );
    }

    break;
  }
  default:
    throw Error('unknown iOS carrier qualification command');
}
