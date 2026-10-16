#include "postgres_fe.h"
#include "common/logging.h"
#include <wchar.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    pg_logging_init(argv[0]);
    const wchar_t *source = GetCommandLineW();
    wchar_t *line = pg_malloc((wcslen(source) + 1) * sizeof(wchar_t));
    wcscpy(line, source);
    wchar_t *command = line;
    // Keep the caller's child argument quoting after our executable.
    int quoted = 0;
    while (*command && (quoted || (*command != L' ' && *command != L'\t'))) {
        if (*command == L'"') quoted = !quoted;
        command++;
    }
    while (*command == L' ' || *command == L'\t') command++;
    HANDLE original = NULL, restricted = NULL;
    SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
    SID_AND_ATTRIBUTES denied[2] = {{0}};
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    DWORD status = 1;
    // Match PostgreSQL's restricted token; its common launcher cannot pass pipe handles.
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &original) ||
        !AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &denied[0].Sid) ||
        !AllocateAndInitializeSid(&authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_POWER_USERS, 0, 0, 0, 0, 0, 0, &denied[1].Sid) ||
        !CreateRestrictedToken(original, DISABLE_MAX_PRIVILEGE, 2, denied,
            0, NULL, 0, NULL, &restricted) ||
        !AddUserToTokenDacl(restricted)) goto failed;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
        !SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
        !SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) ||
        !CreateProcessAsUserW(restricted, NULL, command, NULL, NULL, TRUE,
            0, NULL, NULL, &startup, &child)) goto failed;
    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(child.hProcess, &status)) goto failed;
    goto cleanup;
failed:
    fprintf(stderr, "restricted process launch failed: Windows error %lu\n", (unsigned long)GetLastError());
    status = 1;
cleanup:
    if (child.hThread) CloseHandle(child.hThread);
    if (child.hProcess) CloseHandle(child.hProcess);
    if (restricted) CloseHandle(restricted);
    if (original) CloseHandle(original);
    for (int i = 0; i < 2; i++) if (denied[i].Sid) FreeSid(denied[i].Sid);
    free(line);
    return (int)status;
}
