import { expect, it, vi } from 'vitest';
const shared = vi.hoisted(() => ({ open: vi.fn(), restore: vi.fn(), openServer: vi.fn() }));
vi.mock('../index.js', () => ({ Oliphaunt: shared }));
import direct, { type OpenConfig as DirectConfig } from '../direct.js';
import broker, { type OpenConfig as BrokerConfig } from '../broker.js';

it('pins topology while sharing the root client and preserving restore and server APIs', async () => {
  await direct.open({ username: 'alice' });
  expect(shared.open).toHaveBeenLastCalledWith({ username: 'alice', topology: 'direct' });
  await broker.open({ brokerExecutable: '/broker' });
  expect(shared.open).toHaveBeenLastCalledWith({ brokerExecutable: '/broker', topology: 'broker' });
  expect(direct.restore).toBe(shared.restore);
  expect(broker.restore).toBe(shared.restore);
  expect(direct.openServer).toBe(shared.openServer);
  await expect(direct.open({ topology: 'broker' } as never)).rejects.toThrow('does not accept');
  await expect(direct.open({ brokerExecutable: '/broker' } as never)).rejects.toThrow(
    'does not accept',
  );
  await expect(broker.open({ topology: 'direct' } as never)).rejects.toThrow('does not accept');
});

export function checkModeTypes(): void {
  const brokerOptions: BrokerConfig = { brokerExecutable: '/broker' };
  void broker.open(brokerOptions);
  // @ts-expect-error Direct mode cannot accept broker configuration, even through a variable.
  const directOptions: DirectConfig = brokerOptions;
  void directOptions;
  // @ts-expect-error An import chooses the topology.
  void direct.open({ topology: 'broker' });
  // @ts-expect-error An import chooses the topology.
  void broker.open({ topology: 'direct' });
}
