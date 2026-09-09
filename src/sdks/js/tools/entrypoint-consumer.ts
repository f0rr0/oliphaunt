import Default from '@oliphaunt/ts';
import Direct from '@oliphaunt/ts/direct';
import Broker from '@oliphaunt/ts/broker';
import { directory } from '@oliphaunt/ts/storage/node';
const config = { storage: directory('/db') };
void Default.open({ ...config, topology: 'broker' });
void Direct.open(config);
void Broker.open({ ...config, brokerExecutable: '/broker' });
void Direct.restore(config.storage, new Uint8Array());
void Broker.openServer();
// @ts-expect-error The import already selected direct mode.
void Direct.open({ topology: 'broker' });
// @ts-expect-error The import already selected broker mode.
void Broker.open({ topology: 'direct' });
const brokerOptions = { ...config, brokerExecutable: '/broker' };
// @ts-expect-error Broker-only options cannot leak through variables into direct mode.
void Direct.open(brokerOptions);
