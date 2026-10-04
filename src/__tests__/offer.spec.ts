import { describe, expect, it } from 'bun:test';
import { repairDeviceOffer } from '../listener';

const DEVICE_OFFER = [
  'v=0',
  'o=- 780 2 IN IP4 0.0.0.0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVP 111',
  'a=rtpmap:111 opus/48000/2',
  'a=mid:0',
  'a=sendrecv',
  'a=fingerprint:sha-256 F5:AD:51',
  'a=candidate:0 1 UDP 2128637439 10.0.0.188 57453 typ host',
  'm=application 50712 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:1',
].join('\r\n');

describe('repairing the device offer', () => {
  const repaired = repairDeviceOffer(DEVICE_OFFER);

  it('upgrades the audio profile to the one the answer uses', () => {
    expect(repaired).toContain('m=audio 9 UDP/TLS/RTP/SAVPF 111');
    expect(repaired).not.toContain('UDP/TLS/RTP/SAVP 111');
  });

  it('adds the Opus parameters every browser sends', () => {
    expect(repaired).toContain('a=fmtp:111 minptime=10;useinbandfec=1');
    expect(repaired).toContain('a=rtcp-fb:111 transport-cc');
  });

  // The data channel carries the captions. Breaking it would cost the one
  // thing that still works on a silent call.
  it('leaves the data channel line alone', () => {
    expect(repaired).toContain('m=application 50712 UDP/DTLS/SCTP webrtc-datachannel');
  });

  // Touching any of these would break the connection outright.
  it('leaves ICE, DTLS and candidates untouched', () => {
    expect(repaired).toContain('a=fingerprint:sha-256 F5:AD:51');
    expect(repaired).toContain('a=candidate:0 1 UDP 2128637439 10.0.0.188 57453 typ host');
  });

  it('returns an offer with no Opus unchanged', () => {
    const noOpus = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
    expect(repairDeviceOffer(noOpus)).toBe(noOpus);
  });
});
