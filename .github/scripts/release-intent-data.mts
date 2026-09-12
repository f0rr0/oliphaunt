switch (Bun.argv[2]) {
  case 'types': {
    const config = JSON.parse(await Bun.stdin.text());
    const sections = config['changelog-sections'];
    if (!Array.isArray(sections) || sections.length === 0) {
      console.error('release-please-config.json must define changelog-sections');
      process.exit(1);
    }
    const types = [...new Set(sections.map((section) => section?.type))];
    if (types.some((type) => typeof type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(type))) {
      console.error(
        'release-please changelog section types must be conventional lowercase identifiers',
      );
      process.exit(1);
    }
    console.log(types.join('|'));

    break;
  }
  case 'versions': {
    let data;
    try {
      data = JSON.parse(await Bun.stdin.text());
    } catch {
      process.exit(0);
    }
    for (const [path, version] of Object.entries(data).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      console.log(`${path}=${version}`);
    }

    break;
  }
  case 'products': {
    const data = JSON.parse(await Bun.stdin.text());
    console.log((data.releaseProducts ?? []).join('\n'));
    break;
  }
  default:
    throw new Error('unknown release-intent data command');
}
