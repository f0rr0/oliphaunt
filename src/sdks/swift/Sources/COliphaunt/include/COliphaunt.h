#ifndef C_OLIPHAUNT_H
#define C_OLIPHAUNT_H

#include "oliphaunt.h"

typedef struct OliphauntSession OliphauntSession;

int32_t oliphaunt_swift_open(
    const char *library_path,
    const OliphauntConfig *config,
    OliphauntSession **out);
int32_t oliphaunt_swift_exec_protocol(
    OliphauntSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
int32_t oliphaunt_swift_exec_protocol_stream(
    OliphauntSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntStreamCallback callback,
    void *callback_context);
int32_t oliphaunt_swift_backup(OliphauntSession *session, uint32_t format, OliphauntResponse *out);
int32_t oliphaunt_swift_restore(const char *library_path, const OliphauntRestoreOptions *options);
int32_t oliphaunt_swift_cancel(OliphauntSession *session);
int32_t oliphaunt_swift_close(OliphauntSession *session);
const char *oliphaunt_swift_last_error(OliphauntSession *session);
const char *oliphaunt_swift_version(OliphauntSession *session);
uint64_t oliphaunt_swift_capabilities(OliphauntSession *session);
void oliphaunt_swift_free_response(OliphauntSession *session, OliphauntResponse *response);

#endif
