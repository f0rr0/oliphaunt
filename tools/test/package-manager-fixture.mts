declare const FIXTURE_VERSION: string;
console.log(
  process.env.OLIPHAUNT_WRAPPER_ARGV_PROBE === '1'
    ? JSON.stringify(process.argv.slice(2))
    : FIXTURE_VERSION,
);
