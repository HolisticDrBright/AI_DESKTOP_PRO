import type { InventoryInterruptionCheckpoint } from './adopted-plan-inventory-interruption';

/** Keep the admitted child alive until its parent stops it. An unresolved
 * Promise alone does not keep Node's event loop or default-unreferenced IPC alive.
 * Parent loss rejects the transaction callback; it can never admit a commit. */
export function pauseInventoryInterruptionCheckpoint(packet: InventoryInterruptionCheckpoint,
  target: NodeJS.Process = process): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!target.connected || !target.send || !target.channel) return reject(new Error('interruption_ipc_refused'));
    target.channel.ref();
    target.once('disconnect', () => reject(new Error('interruption_parent_disconnected')));
    target.send(packet, error => { if (error) reject(new Error('interruption_ipc_refused')); });
  });
}
