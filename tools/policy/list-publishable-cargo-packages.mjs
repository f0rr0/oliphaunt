#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    encoding: 'utf8',
  }),
);

const packages = [...metadata.packages].sort((left, right) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
);

for (const cargoPackage of packages) {
  if (Array.isArray(cargoPackage.publish) && cargoPackage.publish.length === 0) {
    continue;
  }
  if (cargoPackage.name === 'oliphaunt-wasix') {
    continue;
  }
  console.log(cargoPackage.name);
}
