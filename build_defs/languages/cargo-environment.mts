import path from 'node:path';

export interface CargoLinkConfiguration {
  linker: string;
  args: string[];
  env: Record<string, string>;
  roots: Record<string, string>;
  cc?: string;
  cxx?: string;
  ar?: string;
  cflags?: string[];
  cxxflags?: string[];
}

export function cargoLinkEnvironment(configuration: CargoLinkConfiguration, runfiles: string) {
  const roots = Object.entries(configuration.roots).sort(([a], [b]) => b.length - a.length);
  const relocate = (input: string) => {
    let value = input;
    for (const [source, destination] of roots) {
      const output = path.join(runfiles, destination);
      if (value === source) return output;
      value = value.replaceAll(`${source}/`, `${output}/`);
    }
    return value;
  };
  const quote = (value: string) =>
    `"${relocate(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return {
    ...Object.fromEntries(
      Object.entries(configuration.env).map(([key, value]) => [key, relocate(value)]),
    ),
    ...(configuration.cc ? { CC: relocate(configuration.cc) } : {}),
    ...(configuration.cxx ? { CXX: relocate(configuration.cxx) } : {}),
    ...(configuration.ar ? { AR: relocate(configuration.ar) } : {}),
    ...(configuration.cflags ? { CFLAGS: configuration.cflags.map(quote).join(' ') } : {}),
    ...(configuration.cxxflags ? { CXXFLAGS: configuration.cxxflags.map(quote).join(' ') } : {}),
    ...(configuration.cflags || configuration.cxxflags
      ? {
          // cc-rs otherwise splits quotes literally and guesses a new target
          // profile. These flags already come from the declared C/C++ provider.
          CC_SHELL_ESCAPED_FLAGS: '1',
          CRATE_CC_NO_DEFAULTS: '1',
        }
      : {}),
    CARGO_ENCODED_RUSTFLAGS: [
      `-Clinker=${relocate(configuration.linker)}`,
      ...configuration.args.map((argument) => `-Clink-arg=${relocate(argument)}`),
    ].join('\x1f'),
  };
}
