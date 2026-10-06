#pragma once

/* Turning a spoken or typed name into the slot it names.
 *
 * Two palettes on this device have names - the character's colours and the
 * screen's themes - and both are reachable by voice now. The lookup lives here
 * rather than in either palette so neither has to grow its own copy, which is
 * the same mistake voice_character.h was written to stop. */

#include <strings.h>

#include <string>

namespace name_lookup {

/* -1 means "no such name". Callers answer with the list rather than guessing:
 * a spoken "chartreuse" should not quietly become whatever happened to be
 * first. */
inline int IndexOf(const char* const* names, int count, const char* name) {
    if (name == nullptr || name[0] == '\0') return -1;
    for (int i = 0; i < count; ++i) {
        if (strcasecmp(name, names[i]) == 0) return i;
    }
    return -1;
}

/* The whole palette, for the answer to a name we do not have. */
inline std::string Names(const char* const* names, int count) {
    std::string out;
    for (int i = 0; i < count; ++i) {
        if (i != 0) out += ", ";
        out += names[i];
    }
    return out;
}

/* What is being worn right now, in words an assistant can read out. */
inline const char* NameOf(const char* const* names, int index, int count) {
    return (index >= 0 && index < count) ? names[index] : "unknown";
}

}  // namespace name_lookup
