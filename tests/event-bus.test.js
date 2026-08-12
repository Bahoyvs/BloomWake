import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/event-bus.js';

describe('EventBus Pub/Sub System', () => {
  it('should deliver event payloads to subscribed listeners', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on('test:event', handler);
    bus.emit('test:event', { foo: 'bar' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('should allow unsubscribing listeners via returning function or off()', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsubscribe = bus.on('test:event', handler);
    bus.emit('test:event', 1);

    unsubscribe();
    bus.emit('test:event', 2);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('should handle once() listeners correctly', () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.once('once:event', handler);
    bus.emit('once:event', 'first');
    bus.emit('once:event', 'second');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('first');
  });

  it('should clear specific or all listeners', () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on('e1', h1);
    bus.on('e2', h2);

    bus.clear('e1');
    bus.emit('e1', 1);
    bus.emit('e2', 2);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);

    bus.clear();
    bus.emit('e2', 3);
    expect(h2).toHaveBeenCalledTimes(1);
  });
});
