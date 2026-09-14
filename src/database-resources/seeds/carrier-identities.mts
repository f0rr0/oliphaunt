import { readFileSync } from 'node:fs';

const contract = JSON.parse(
  readFileSync(new URL('../contracts/contract.json', import.meta.url), 'utf8'),
);

export function seedCarrierIdentities() {
  return [
    ...Object.keys(contract.compatibilityKeys.native).map((target) => ({
      family: 'native',
      target,
    })),
    { family: 'wasix', target: 'portable' },
  ].flatMap(({ family, target }) =>
    Object.keys(contract.profiles).map((profile) => {
      const suffix = `${family}${family === 'native' ? `-${target}` : ''}-${profile}`;
      return {
        family,
        target,
        profile,
        suffix,
        npm: `@oliphaunt/seed-${suffix}`,
        cargo: `oliphaunt-seed-${suffix}`,
      };
    }),
  );
}
