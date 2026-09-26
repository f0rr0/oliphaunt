#include "liboliphaunt_internal.h"

#include <string.h>

static uint32_t read_be32(const uint8_t *ptr) {
    return ((uint32_t)ptr[0] << 24) |
           ((uint32_t)ptr[1] << 16) |
           ((uint32_t)ptr[2] << 8) |
           (uint32_t)ptr[3];
}

bool oliphaunt_response_confirms_command(
    const uint8_t *response,
    size_t response_len,
    const char *expected_tag,
    bool *tag_matches) {
    *tag_matches = false;
    bool saw_command_complete = false;
    bool command_tag_matches = false;
    size_t off = 0;
    while (off < response_len) {
        if (response_len - off < 5) {
            return false;
        }
        uint8_t tag = response[off];
        uint32_t len = read_be32(response + off + 1);
        if (len < 4 || (size_t)len + 1 > response_len - off || tag == 'E') {
            return false;
        }
        if (tag == 'C') {
            size_t expected_len = strlen(expected_tag) + 1;
            size_t body_len = (size_t)len - 4;
            bool this_tag_matches =
                body_len == expected_len &&
                memcmp(response + off + 5, expected_tag, expected_len) == 0;
            command_tag_matches = !saw_command_complete && this_tag_matches;
            saw_command_complete = true;
        }
        size_t next = off + (size_t)len + 1;
        if (tag == 'Z') {
            bool confirmed =
                saw_command_complete &&
                len == 5 &&
                next == response_len &&
                (response[off + 5] == 'I' ||
                 response[off + 5] == 'T' ||
                 response[off + 5] == 'E');
            *tag_matches = confirmed && command_tag_matches;
            return confirmed;
        }
        off = next;
    }
    return false;
}

bool oliphaunt_backup_cleanup_required(OliphauntBackupModeState state) {
    return state == OLIPHAUNT_BACKUP_EXIT_REQUIRED ||
           state == OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED;
}

OliphauntBackupCleanupOutcome oliphaunt_backup_cleanup_outcome(
    int stop_rc,
    OliphauntBackupModeState stop_state) {
    if (stop_rc == 0) {
        return OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED;
    }
    if (stop_state == OLIPHAUNT_BACKUP_EXIT_CONFIRMED) {
        return OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED_WITH_VALIDATION_FAILURE;
    }
    return OLIPHAUNT_BACKUP_CLEANUP_UNCONFIRMED;
}

void oliphaunt_run_failed_backup_cleanup(
    OliphauntBackupModeState state,
    const char *primary_error,
    OliphauntBackupStopAttempt stop,
    void *stop_context,
    OliphauntBackupCleanupResult *out) {
    out->state = state;
    out->poison = false;
    snprintf(out->error, sizeof(out->error), "%s", primary_error != NULL ? primary_error : "");
    if (!oliphaunt_backup_cleanup_required(state)) {
        return;
    }

    char cleanup_error[sizeof(out->error)] = {0};
    OliphauntBackupModeState cleanup_state = OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED;
    int stop_rc = stop(stop_context, &cleanup_state, cleanup_error, sizeof(cleanup_error));
    OliphauntBackupCleanupOutcome outcome =
        oliphaunt_backup_cleanup_outcome(stop_rc, cleanup_state);
    if (outcome == OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED) {
        out->state = OLIPHAUNT_BACKUP_EXIT_CONFIRMED;
        return;
    }
    if (outcome == OLIPHAUNT_BACKUP_CLEANUP_CONFIRMED_WITH_VALIDATION_FAILURE) {
        out->state = OLIPHAUNT_BACKUP_EXIT_CONFIRMED;
        snprintf(
            out->error,
            sizeof(out->error),
            "%.440s; PostgreSQL left backup mode but cleanup validation also failed: %.440s",
            primary_error != NULL ? primary_error : "",
            cleanup_error);
        return;
    }

    out->state = OLIPHAUNT_BACKUP_EXIT_UNCONFIRMED;
    out->poison = true;
    snprintf(
        out->error,
        sizeof(out->error),
        "%.440s; PostgreSQL could not confirm leaving backup mode cleanly: %.440s",
        primary_error != NULL ? primary_error : "",
        cleanup_error);
}

OliphauntDataRowValidation oliphaunt_validate_data_row(
    const uint8_t *body,
    size_t body_len,
    uint16_t expected_columns) {
    if (body_len < 2) {
        return OLIPHAUNT_DATA_ROW_TRUNCATED_COUNT;
    }
    uint16_t columns = ((uint16_t)body[0] << 8) | (uint16_t)body[1];
    if (columns != expected_columns) {
        return OLIPHAUNT_DATA_ROW_UNEXPECTED_COUNT;
    }

    const uint8_t *p = body + 2;
    size_t remaining = body_len - 2;
    for (uint16_t column = 0; column < columns; column++) {
        if (remaining < 4) {
            return OLIPHAUNT_DATA_ROW_TRUNCATED_LENGTH;
        }
        uint32_t raw_value_len = ((uint32_t)p[0] << 24) |
                                 ((uint32_t)p[1] << 16) |
                                 ((uint32_t)p[2] << 8) |
                                 (uint32_t)p[3];
        int32_t value_len = (int32_t)raw_value_len;
        p += 4;
        remaining -= 4;
        if (value_len == -1) {
            continue;
        }
        if (value_len < 0 || (size_t)value_len > remaining) {
            return OLIPHAUNT_DATA_ROW_TRUNCATED_VALUE;
        }
        p += value_len;
        remaining -= (size_t)value_len;
    }
    return remaining == 0 ? OLIPHAUNT_DATA_ROW_VALID : OLIPHAUNT_DATA_ROW_TRAILING_BYTES;
}
