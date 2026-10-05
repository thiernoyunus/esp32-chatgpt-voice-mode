#include "codex_voice_udp.h"

#include <errno.h>
#include <netinet/in.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>

#include "esp_log.h"
#include "udp.h"

static atomic_bool first_rtp_pending = ATOMIC_VAR_INIT(true);

void codex_voice_reset_first_rtp(void) {
    atomic_store(&first_rtp_pending, true);
}

// esp_peer 1.5.4 treats a stray first comfort-noise packet as its sequence
// baseline. Later speech can then be discarded for minutes. This replaces its
// weak receive function and drops that first RTP packet before peer sees it.
// Keep the socket behavior in sync with esp_peer/src/transport/udp.c.
int udp_socket_recvfrom_nowait(udp_socket_t *socket, esp_peer_addr_t *addr,
                               uint8_t *buf, int len, bool nowait) {
    if (socket->fd < 0 && socket->ipv6_fd < 0) return -1;

    fd_set read_set;
    FD_ZERO(&read_set);
    int max_fd = -1;
    if (socket->fd >= 0) {
        FD_SET(socket->fd, &read_set);
        max_fd = socket->fd;
    }
    if (socket->ipv6_fd >= 0) {
        FD_SET(socket->ipv6_fd, &read_set);
        if (socket->ipv6_fd > max_fd) max_fd = socket->ipv6_fd;
    }
    struct timeval timeout = nowait ? (struct timeval){0, 0}
                                    : (struct timeval){socket->timeout_sec, socket->timeout_usec};
    atomic_fetch_add(&socket->user_count, 1);
    int ret = select(max_fd + 1, &read_set, NULL, NULL, &timeout);
    if (ret <= 0) {
        if (ret < 0) ESP_LOGE("VoiceUDP", "select failed: %s", strerror(errno));
        atomic_fetch_sub(&socket->user_count, 1);
        return ret;
    }

    const int fd = socket->fd >= 0 && FD_ISSET(socket->fd, &read_set)
                       ? socket->fd : socket->ipv6_fd;
    struct sockaddr_storage source;
    socklen_t source_size = sizeof(source);
    ret = recvfrom(fd, buf, len, 0, (struct sockaddr *)&source, &source_size);
    atomic_fetch_sub(&socket->user_count, 1);
    if (ret < 0) {
        if (errno == EWOULDBLOCK) return 0;
        ESP_LOGE("VoiceUDP", "recvfrom failed: %s", strerror(errno));
        return -1;
    }
    if (ret == 0) return -1;
    if (source.ss_family == AF_INET) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)&source;
        addr->family = AF_INET;
        addr->port = ntohs(ipv4->sin_port);
        memcpy(addr->ipv4, &ipv4->sin_addr.s_addr, 4);
    } else if (source.ss_family == AF_INET6) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)&source;
        addr->family = AF_INET6;
        addr->port = ntohs(ipv6->sin6_port);
        memcpy(addr->ipv6, &ipv6->sin6_addr, 16);
    }

    if (codex_voice_is_rtp(buf, ret) && atomic_exchange(&first_rtp_pending, false)) {
        ESP_LOGI("VoiceUDP", "Skipped stray first RTP packet (seq %u)",
                 (unsigned)((buf[2] << 8) | buf[3]));
        return 0;
    }
    return ret;
}
