// Renders a car's engine sounds off the main thread, so picking a car doesn't stall the menu.

import { renderBank } from './engine-render';
import { carSound } from './engine-sounds';

self.onmessage = (event: MessageEvent<{ id: string }>) => {
  const { id } = event.data;
  const bank = renderBank(carSound(id).engine);
  const buffers = [...bank.on, ...bank.off].flatMap((loop) => [loop.exhaust.buffer, loop.bay.buffer]);
  buffers.push(...bank.pops.map((pop) => pop.buffer), ...bank.starter.map((channel) => channel.buffer));
  self.postMessage({ id, bank }, { transfer: buffers as ArrayBuffer[] });
};
