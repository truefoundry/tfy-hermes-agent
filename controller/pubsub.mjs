import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0);

const channel = (runId) => `run:${runId}`;

export function subscribe(runId, handler) {
  const ch = channel(runId);
  bus.on(ch, handler);
  return () => bus.off(ch, handler);
}

export function publish(runId, event) {
  bus.emit(channel(runId), event);
}

export function listenerCount(runId) {
  return bus.listenerCount(channel(runId));
}
