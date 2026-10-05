#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void codex_voice_reset_first_rtp(void);

// RTP and RTCP share the port. STUN, DTLS and RTCP must reach the peer intact.
static inline bool codex_voice_is_rtp(const uint8_t *packet, int size) {
    return size >= 12 && (packet[0] & 0xC0) == 0x80 &&
           (packet[1] < 192 || packet[1] > 223);
}

#ifdef __cplusplus
}
#endif
