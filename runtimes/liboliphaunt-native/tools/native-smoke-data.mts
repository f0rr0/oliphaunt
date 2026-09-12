import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [operation, value] = process.argv.slice(2);
switch (operation) {
  case 'postgres-version':
    console.log(
      Bun.TOML.parse(readFileSync('third-party/postgres/source.toml', 'utf8')).postgresql.version,
    );
    break;
  case 'profile': {
    const fixture = JSON.parse(
      readFileSync('database-resources/contracts/profile-probe.json', 'utf8'),
    );
    const probe = fixture.profiles?.[value];
    if (fixture.schema !== 'oliphaunt-cluster-seed-profile-probe-v1' || !probe)
      throw new Error(`missing cluster-seed profile ${value}`);
    for (const field of ['sql', 'expected']) {
      if (typeof probe[field] !== 'string' || /[\r\n\0]/u.test(probe[field]))
        throw new Error(`invalid ${value}.${field}`);
      console.log(probe[field]);
    }
    break;
  }
  case 'managed-root': {
    const descriptor = join(value, '.oliphaunt.json');
    writeFileSync(
      `${descriptor}.tmp`,
      '{"schema":"oliphaunt-database-root-v1","engineFamily":"native","pgdata":"pgdata","postgresMajor":18,"physicalFormat":"native-pg18-v1"}\n',
      { flag: 'wx', mode: 0o600 },
    );
    renameSync(`${descriptor}.tmp`, descriptor);
    break;
  }
  default:
    throw new Error(`unknown native smoke data operation ${operation}`);
}
