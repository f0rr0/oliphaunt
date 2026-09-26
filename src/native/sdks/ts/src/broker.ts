import { Oliphaunt as client } from './index.js';
import type * as Types from './types.js';
export * from './index.js';

export type OpenConfig = Omit<Types.OpenConfig, 'topology'> & { topology?: never };
export type OliphauntClient = Omit<Types.OliphauntClient, 'open'> & {
  open(config?: OpenConfig): Promise<Types.OliphauntDatabase>;
};
export const Oliphaunt: OliphauntClient = {
  ...client,
  async open(config = {}) {
    if (config.topology !== undefined) {
      throw new TypeError(
        '@oliphaunt/ts/broker does not accept topology; select the execution mode through the import path',
      );
    }
    return client.open({ ...config, topology: 'broker' });
  },
};
export default Oliphaunt;
