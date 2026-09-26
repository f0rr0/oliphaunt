import { Oliphaunt as client } from './index.js';
import type * as Types from './types.js';
export * from './index.js';

export type OpenConfig = Omit<Types.OpenConfig, 'topology' | 'brokerExecutable'> & {
  topology?: never;
  brokerExecutable?: never;
};
export type OliphauntClient = Omit<Types.OliphauntClient, 'open'> & {
  open(config?: OpenConfig): Promise<Types.OliphauntDatabase>;
};
export const Oliphaunt: OliphauntClient = {
  ...client,
  async open(config = {}) {
    if (config.topology !== undefined || config.brokerExecutable !== undefined) {
      throw new TypeError(
        '@oliphaunt/ts/direct does not accept topology or brokerExecutable; select the execution mode through the import path',
      );
    }
    return client.open({ ...config, topology: 'direct' });
  },
};
export default Oliphaunt;
