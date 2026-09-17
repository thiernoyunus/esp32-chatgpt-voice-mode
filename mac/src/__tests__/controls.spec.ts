import { describe, expect, it } from 'bun:test';

import { DeviceToolBridge } from '../controls';

/** Reads the tool call the bridge just put on the wire. */
function readSentCall(sent: string[]): { id: number; name: string; arguments: unknown } {
  const payload = JSON.parse(sent.at(-1)!).payload;
  return { id: payload.id, name: payload.params.name, arguments: payload.params.arguments };
}

describe('asking the device to do something', () => {
  it('sends the tool call and settles when the device answers', async () => {
    const sent: string[] = [];
    const bridge = new DeviceToolBridge();
    bridge.setDeviceConnection((text) => sent.push(text));

    const pending = bridge.call('self.audio_speaker.set_volume', { volume: 30 });
    const call = readSentCall(sent);
    expect(call.name).toBe('self.audio_speaker.set_volume');
    expect(call.arguments).toEqual({ volume: 30 });

    bridge.acceptReply({
      type: 'mcp',
      payload: { jsonrpc: '2.0', id: call.id, result: true },
    });
    expect(await pending).toEqual({ ok: true, result: true });
  });

  it('says so plainly when no device is connected', async () => {
    const bridge = new DeviceToolBridge();
    expect(bridge.isDeviceConnected).toBe(false);
    const outcome = await bridge.call('self.get_device_status', {});
    expect(outcome).toEqual({ ok: false, reason: 'the device is not connected' });
  });

  it('passes the device’s own refusal back rather than inventing one', async () => {
    const sent: string[] = [];
    const bridge = new DeviceToolBridge();
    bridge.setDeviceConnection((text) => sent.push(text));

    const pending = bridge.call('self.screen.capture', { quality: 80 });
    bridge.acceptReply({
      type: 'mcp',
      payload: {
        jsonrpc: '2.0',
        id: readSentCall(sent).id,
        error: { code: -32000, message: 'Failed to capture screen' },
      },
    });
    expect(await pending).toEqual({ ok: false, reason: 'Failed to capture screen' });
  });

  it('releases a waiting call when the device disappears', async () => {
    // Without this the caller waits out the full twenty-second ceiling for a
    // device that is demonstrably gone, and the assistant just goes quiet.
    const bridge = new DeviceToolBridge();
    bridge.setDeviceConnection(() => {});
    const pending = bridge.call('self.get_device_status', {});
    bridge.setDeviceConnection(null);
    expect(await pending).toEqual({
      ok: false,
      reason: 'the device disconnected mid-call',
    });
  });

  it('gives each call its own id so two in flight cannot be confused', async () => {
    const sent: string[] = [];
    const bridge = new DeviceToolBridge();
    bridge.setDeviceConnection((text) => sent.push(text));

    const first = bridge.call('self.get_device_status', {});
    const firstId = readSentCall(sent).id;
    const second = bridge.call('self.audio_speaker.set_volume', { volume: 10 });
    const secondId = readSentCall(sent).id;
    expect(secondId).not.toBe(firstId);

    // Answer them out of order: the wrong pairing is the bug this catches.
    bridge.acceptReply({
      type: 'mcp',
      payload: { jsonrpc: '2.0', id: secondId, result: 'second' },
    });
    bridge.acceptReply({
      type: 'mcp',
      payload: { jsonrpc: '2.0', id: firstId, result: 'first' },
    });
    expect(await first).toEqual({ ok: true, result: 'first' });
    expect(await second).toEqual({ ok: true, result: 'second' });
  });

  it('ignores a reply that arrives after its caller gave up', () => {
    const bridge = new DeviceToolBridge();
    bridge.setDeviceConnection(() => {});
    expect(() =>
      bridge.acceptReply({
        type: 'mcp',
        payload: { jsonrpc: '2.0', id: 999, result: true },
      }),
    ).not.toThrow();
  });
});

describe('a device that reconnects', () => {
  it('keeps the newest connection when an old socket closes late', async () => {
    // The device's new socket opens before the old one's close arrives, so a
    // close that does not check whether it is still the current device clears
    // the connection that just replaced it. Seen live: the socket was open and
    // established while every tool call answered "the device is not connected".
    const sentToOld: string[] = [];
    const sentToNew: string[] = [];
    const bridge = new DeviceToolBridge();

    bridge.setDeviceConnection((text) => sentToOld.push(text));
    bridge.setDeviceConnection((text) => sentToNew.push(text));

    // The old socket's close must not reach past the new registration. The
    // listener guards this by comparing sockets; this pins the consequence.
    expect(bridge.isDeviceConnected).toBe(true);

    const pending = bridge.call('self.get_device_status', {});
    expect(sentToNew).toHaveLength(1);
    expect(sentToOld).toHaveLength(0);

    const payload = JSON.parse(sentToNew[0]!).payload;
    bridge.acceptReply({
      type: 'mcp',
      payload: { jsonrpc: '2.0', id: payload.id, result: 'ok' },
    });
    expect(await pending).toEqual({ ok: true, result: 'ok' });
  });
});
