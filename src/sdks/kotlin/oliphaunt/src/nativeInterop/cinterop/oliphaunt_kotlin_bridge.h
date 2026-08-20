#ifndef OLIPHAUNT_KOTLIN_BRIDGE_H
#define OLIPHAUNT_KOTLIN_BRIDGE_H

#include "oliphaunt.h"

typedef struct OliphauntKotlinSession OliphauntKotlinSession;

OliphauntKotlinSession *oliphaunt_kotlin_open(
    const char *library_path,
    const OliphauntConfig *config);
int32_t oliphaunt_kotlin_exec_protocol(
    OliphauntKotlinSession *session,
    const uint8_t *request,
    size_t request_len,
    OliphauntResponse *out);
int32_t oliphaunt_kotlin_backup(OliphauntKotlinSession *session, OliphauntResponse *out);
int32_t oliphaunt_kotlin_restore(const char *library_path, const OliphauntRestoreOptions *options);
int32_t oliphaunt_kotlin_cancel(OliphauntKotlinSession *session);
int32_t oliphaunt_kotlin_close(OliphauntKotlinSession *session);
const char *oliphaunt_kotlin_last_error(OliphauntKotlinSession *session);
void oliphaunt_kotlin_free_response(OliphauntKotlinSession *session, OliphauntResponse *response);
int32_t oliphaunt_kotlin_remove_tree(const char *path);
int32_t oliphaunt_kotlin_initialize_root(
    const char *root,
    const char *runtime_directory,
    const char *username);

#endif
