#include "pxii_vfs.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <stdatomic.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

SQLITE_EXTENSION_INIT1

#define PXII_TOKEN_MAX 96
#define PXII_NAME_MAX 255
#define PXII_SHM_MAPS 32
#define PXII_PENDING_BYTE ((sqlite3_int64)0x40000000)
#define PXII_RESERVED_BYTE (PXII_PENDING_BYTE + 1)
#define PXII_SHARED_FIRST (PXII_PENDING_BYTE + 2)
#define PXII_SHARED_SIZE 510
#define PXII_POSIX_DELETE_DEFERRED SQLITE_IOERR_DELETE

#if defined(_WIN32)
typedef HANDLE PxiiHandle;
#define PXII_INVALID_HANDLE INVALID_HANDLE_VALUE
#else
typedef int PxiiHandle;
#define PXII_INVALID_HANDLE (-1)
#endif

typedef struct PxiiBinding PxiiBinding;
typedef struct PxiiFile PxiiFile;

typedef struct PxiiIdentity {
    uint64_t device;
    uint64_t file_id;
} PxiiIdentity;

typedef struct PxiiBoundChild {
    const char *suffix;
    int state;
    PxiiIdentity identity;
} PxiiBoundChild;

struct PxiiBinding {
    char token[PXII_TOKEN_MAX];
    char basename[PXII_NAME_MAX + 1];
    PxiiHandle parent;
    PxiiHandle main_file;
    PxiiIdentity main_identity;
    PxiiBoundChild journal;
    PxiiBoundChild wal;
    PxiiBoundChild shm;
    int revoked;
    int references;
    int open_delay_ms;
    PxiiBinding *next;
};

typedef struct PxiiMap {
    void *view;
    void *base;
    size_t length;
#if defined(_WIN32)
    HANDLE mapping;
#endif
} PxiiMap;

struct PxiiFile {
    sqlite3_file base;
    PxiiBinding *binding;
    PxiiHandle handle;
    PxiiHandle shm_handle;
    int lock_level;
    int delete_on_close;
    int is_temp;
    int is_memory;
    int last_errno;
    const char *role_suffix;
    PxiiIdentity identity;
    PxiiIdentity shm_identity;
    unsigned char *memory;
    sqlite3_int64 memory_size;
    sqlite3_int64 memory_capacity;
    PxiiMap maps[PXII_SHM_MAPS];
};

static sqlite3_vfs g_vfs;
static sqlite3_vfs *g_stock_vfs = NULL;
static sqlite3_mutex *g_registry_mutex = NULL;
static PxiiBinding *g_bindings = NULL;
static PxiiHandle g_temp_root = PXII_INVALID_HANDLE;

static void trace_event(const char *event, sqlite3_int64 first, sqlite3_int64 second) {
    if (getenv("PXII_VFS_TRACE") != NULL) {
        fprintf(stderr, "pxii-vfs %s %lld %lld\n", event, (long long)first, (long long)second);
        fflush(stderr);
    }
}

static int pxii_close(sqlite3_file *file);
static int pxii_read(sqlite3_file *file, void *buffer, int amount, sqlite3_int64 offset);
static int pxii_write(sqlite3_file *file, const void *buffer, int amount, sqlite3_int64 offset);
static int pxii_truncate(sqlite3_file *file, sqlite3_int64 size);
static int pxii_sync(sqlite3_file *file, int flags);
static int pxii_file_size(sqlite3_file *file, sqlite3_int64 *size);
static int pxii_lock(sqlite3_file *file, int level);
static int pxii_unlock(sqlite3_file *file, int level);
static int pxii_check_reserved_lock(sqlite3_file *file, int *result);
static int pxii_file_control(sqlite3_file *file, int operation, void *argument);
static int pxii_sector_size(sqlite3_file *file);
static int pxii_device_characteristics(sqlite3_file *file);
static int pxii_shm_map(sqlite3_file *file, int page, int page_size, int extend, void volatile **out);
static int pxii_shm_lock(sqlite3_file *file, int offset, int count, int flags);
static void pxii_shm_barrier(sqlite3_file *file);
static int pxii_shm_unmap(sqlite3_file *file, int delete_flag);
static int pxii_fetch(sqlite3_file *file, sqlite3_int64 offset, int amount, void **out);
static int pxii_unfetch(sqlite3_file *file, sqlite3_int64 offset, void *value);

static const sqlite3_io_methods g_io_methods = {
    3,
    pxii_close,
    pxii_read,
    pxii_write,
    pxii_truncate,
    pxii_sync,
    pxii_file_size,
    pxii_lock,
    pxii_unlock,
    pxii_check_reserved_lock,
    pxii_file_control,
    pxii_sector_size,
    pxii_device_characteristics,
    pxii_shm_map,
    pxii_shm_lock,
    pxii_shm_barrier,
    pxii_shm_unmap,
    pxii_fetch,
    pxii_unfetch,
};

static void registry_enter(void) {
    sqlite3_mutex_enter(g_registry_mutex);
}

static void registry_leave(void) {
    sqlite3_mutex_leave(g_registry_mutex);
}

static int binding_is_revoked(PxiiBinding *binding) {
    int revoked;
    registry_enter();
    revoked = binding->revoked;
    registry_leave();
    return revoked;
}

static int handle_valid(PxiiHandle handle) {
#if defined(_WIN32)
    return handle != NULL && handle != INVALID_HANDLE_VALUE;
#else
    return handle >= 0;
#endif
}

static void handle_close(PxiiHandle handle) {
    if (!handle_valid(handle)) {
        return;
    }
#if defined(_WIN32)
    CloseHandle(handle);
#else
    close(handle);
#endif
}

static int handle_duplicate(PxiiHandle source, PxiiHandle *target) {
#if defined(_WIN32)
    if (!DuplicateHandle(
            GetCurrentProcess(), source, GetCurrentProcess(), target, 0, FALSE,
            DUPLICATE_SAME_ACCESS)) {
        return SQLITE_CANTOPEN;
    }
#else
    *target = dup(source);
    if (*target < 0) {
        return SQLITE_CANTOPEN;
    }
#endif
    return SQLITE_OK;
}

static int handle_identity(PxiiHandle handle, PxiiIdentity *identity) {
#if defined(_WIN32)
    BY_HANDLE_FILE_INFORMATION info;
    if (!GetFileInformationByHandle(handle, &info)) {
        return SQLITE_IOERR_FSTAT;
    }
    identity->device = (uint64_t)info.dwVolumeSerialNumber;
    identity->file_id = ((uint64_t)info.nFileIndexHigh << 32) | info.nFileIndexLow;
#else
    struct stat info;
    if (fstat(handle, &info) != 0) {
        return SQLITE_IOERR_FSTAT;
    }
    identity->device = (uint64_t)info.st_dev;
    identity->file_id = (uint64_t)info.st_ino;
#endif
    return SQLITE_OK;
}

static int identity_equal(const PxiiIdentity *left, const PxiiIdentity *right) {
    return left->device == right->device && left->file_id == right->file_id;
}

static int exact_basename(const char *value) {
    size_t length;
    if (value == NULL || value[0] == '\0') {
        return 0;
    }
    length = strlen(value);
    if (length > PXII_NAME_MAX || strcmp(value, ".") == 0 || strcmp(value, "..") == 0) {
        return 0;
    }
    return strchr(value, '/') == NULL && strchr(value, '\\') == NULL && strchr(value, ':') == NULL;
}

static PxiiBinding *binding_find_locked(const char *token, size_t length) {
    PxiiBinding *binding = g_bindings;
    while (binding != NULL) {
        if (strlen(binding->token) == length && memcmp(binding->token, token, length) == 0) {
            return binding;
        }
        binding = binding->next;
    }
    return NULL;
}

static int parse_virtual_name(
    const char *name,
    PxiiBinding **binding_out,
    const char **suffix_out
) {
    const char *start = name;
    const char *suffix;
    size_t token_length;
    PxiiBinding *binding;
    if (name == NULL) {
        return SQLITE_CANTOPEN;
    }
    if (strncmp(start, "file:", 5) == 0) {
        start += 5;
    }
    if (strncmp(start, "pxii-", 5) != 0) {
        return SQLITE_CANTOPEN;
    }
    start += 5;
    suffix = start;
    while (*suffix != '\0' && *suffix != '?' && *suffix != '-') {
        suffix += 1;
    }
    token_length = (size_t)(suffix - start);
    if (token_length == 0 || token_length >= PXII_TOKEN_MAX) {
        return SQLITE_CANTOPEN;
    }
    registry_enter();
    binding = binding_find_locked(start, token_length);
    if (binding == NULL || binding->revoked) {
        registry_leave();
        return SQLITE_AUTH;
    }
    binding->references += 1;
    registry_leave();
    *binding_out = binding;
    *suffix_out = suffix;
    return SQLITE_OK;
}

static void binding_close_if_terminal_locked(PxiiBinding *binding) {
    if (binding->revoked && binding->references == 0) {
        PxiiBinding **cursor = &g_bindings;
        while (*cursor != NULL && *cursor != binding) {
            cursor = &(*cursor)->next;
        }
        if (*cursor == binding) {
            *cursor = binding->next;
        }
        handle_close(binding->main_file);
        handle_close(binding->parent);
        binding->main_file = PXII_INVALID_HANDLE;
        binding->parent = PXII_INVALID_HANDLE;
        sqlite3_free(binding);
    }
}

static void binding_release(PxiiBinding *binding) {
    if (binding == NULL) {
        return;
    }
    registry_enter();
    if (binding->references > 0) {
        binding->references -= 1;
    }
    binding_close_if_terminal_locked(binding);
    registry_leave();
}

#if defined(_WIN32)
typedef LONG NTSTATUS;
typedef struct PxiiUnicodeString {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR Buffer;
} PxiiUnicodeString;
typedef struct PxiiObjectAttributes {
    ULONG Length;
    HANDLE RootDirectory;
    PxiiUnicodeString *ObjectName;
    ULONG Attributes;
    PVOID SecurityDescriptor;
    PVOID SecurityQualityOfService;
} PxiiObjectAttributes;
typedef struct PxiiIoStatusBlock {
    union { NTSTATUS Status; PVOID Pointer; } value;
    ULONG_PTR Information;
} PxiiIoStatusBlock;
typedef NTSTATUS (NTAPI *PxiiNtCreateFile)(
    PHANDLE, ACCESS_MASK, PxiiObjectAttributes *, PxiiIoStatusBlock *, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG
);

static int windows_relative_open(
    HANDLE parent,
    const char *name,
    int create_mode,
    HANDLE *result
) {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    PxiiNtCreateFile nt_create_file;
    wchar_t wide_name[PXII_NAME_MAX + 1];
    PxiiUnicodeString unicode_name;
    PxiiObjectAttributes attributes;
    PxiiIoStatusBlock status;
    FILE_ATTRIBUTE_TAG_INFO tag_info;
    NTSTATUS code;
    int wide_length;
    ACCESS_MASK desired_access;
    ULONG share_access;
    if (ntdll == NULL || !exact_basename(name)) {
        return SQLITE_CANTOPEN;
    }
    {
        FARPROC procedure = GetProcAddress(ntdll, "NtCreateFile");
        _Static_assert(sizeof(procedure) == sizeof(nt_create_file), "function pointer ABI");
        memcpy(&nt_create_file, &procedure, sizeof(nt_create_file));
    }
    if (nt_create_file == NULL) {
        return SQLITE_CANTOPEN;
    }
    wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, -1, wide_name, PXII_NAME_MAX + 1);
    if (wide_length <= 1) {
        return SQLITE_CANTOPEN;
    }
    unicode_name.Length = (USHORT)((wide_length - 1) * (int)sizeof(wchar_t));
    unicode_name.MaximumLength = (USHORT)(wide_length * (int)sizeof(wchar_t));
    unicode_name.Buffer = wide_name;
    memset(&attributes, 0, sizeof(attributes));
    attributes.Length = sizeof(attributes);
    attributes.RootDirectory = parent;
    attributes.ObjectName = &unicode_name;
    attributes.Attributes = 0x00000040UL;
    memset(&status, 0, sizeof(status));
    desired_access = GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE;
    share_access = FILE_SHARE_READ | FILE_SHARE_WRITE;
    if (create_mode >= 3) {
        desired_access |= DELETE;
        share_access |= FILE_SHARE_DELETE;
    }
    code = nt_create_file(
        result,
        desired_access,
        &attributes,
        &status,
        NULL,
        FILE_ATTRIBUTE_NORMAL,
        share_access,
        (create_mode == 2 || create_mode == 4)
            ? 0x00000002UL
            : (create_mode == 1 ? 0x00000003UL : 0x00000001UL),
        0x00000040UL | 0x00200000UL | (create_mode == 4 ? 0x00001000UL : 0),
        NULL,
        0
    );
    if (code < 0) {
        *result = INVALID_HANDLE_VALUE;
        if ((uint32_t)code == UINT32_C(0xc0000034) ||
            (uint32_t)code == UINT32_C(0xc000003a)) {
            return SQLITE_NOTFOUND;
        }
        return SQLITE_CANTOPEN;
    }
    if (!GetFileInformationByHandleEx(*result, FileAttributeTagInfo, &tag_info, sizeof(tag_info)) ||
        (tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        CloseHandle(*result);
        *result = INVALID_HANDLE_VALUE;
        return SQLITE_CANTOPEN;
    }
    return SQLITE_OK;
}
#else
static int posix_relative_open(int parent, const char *name, int create_mode, int *result) {
    int flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW;
    if (!exact_basename(name)) {
        return SQLITE_CANTOPEN;
    }
    if (create_mode != 0) {
        flags |= O_CREAT;
    }
    if (create_mode == 2) {
        flags |= O_EXCL;
    }
    *result = openat(parent, name, flags, 0600);
    if (*result >= 0) {
        return SQLITE_OK;
    }
    return errno == ENOENT ? SQLITE_NOTFOUND : SQLITE_CANTOPEN;
}
#endif

static int initialize_temp_root(void) {
#if defined(_WIN32)
    wchar_t directory[MAX_PATH + 1];
    FILE_ATTRIBUTE_TAG_INFO tag_info;
    DWORD length = GetTempPathW(MAX_PATH, directory);
    if (length == 0 || length > MAX_PATH) {
        return SQLITE_CANTOPEN;
    }
    g_temp_root = CreateFileW(
        directory,
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        NULL
    );
    if (!handle_valid(g_temp_root)) {
        return SQLITE_CANTOPEN;
    }
    if (!GetFileInformationByHandleEx(
            g_temp_root, FileAttributeTagInfo, &tag_info, sizeof(tag_info)) ||
        (tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        handle_close(g_temp_root);
        g_temp_root = PXII_INVALID_HANDLE;
        return SQLITE_CANTOPEN;
    }
#else
    const char *configured = getenv("TMPDIR");
    const char *directory = configured != NULL && configured[0] != '\0' ? configured : "/tmp";
    g_temp_root = open(
        directory,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    );
    if (!handle_valid(g_temp_root)) {
        return SQLITE_CANTOPEN;
    }
#endif
    return SQLITE_OK;
}

static PxiiBoundChild *binding_child(PxiiBinding *binding, const char *suffix) {
    if (strcmp(suffix, "-journal") == 0) {
        return &binding->journal;
    }
    if (strcmp(suffix, "-wal") == 0) {
        return &binding->wal;
    }
    if (strcmp(suffix, "-shm") == 0) {
        return &binding->shm;
    }
    return NULL;
}

static int relative_open(
    PxiiBinding *binding,
    const char *name,
    int create_mode,
    PxiiHandle *result
) {
#if defined(_WIN32)
    return windows_relative_open(binding->parent, name, create_mode, result);
#else
    return posix_relative_open(binding->parent, name, create_mode, result);
#endif
}

static int binding_open_companion(
    PxiiBinding *binding,
    const char *suffix,
    int create,
    PxiiHandle *result
) {
    char name[PXII_NAME_MAX + 16];
    int written;
    int result_code;
    int create_mode;
    PxiiIdentity observed;
    PxiiBoundChild *child = binding_child(binding, suffix);
    if (child == NULL) {
        return SQLITE_CANTOPEN;
    }
    written = snprintf(name, sizeof(name), "%s%s", binding->basename, suffix);
    if (written <= 0 || (size_t)written >= sizeof(name)) {
        return SQLITE_CANTOPEN;
    }
    registry_enter();
    if (binding->revoked) {
        registry_leave();
        *result = PXII_INVALID_HANDLE;
        return SQLITE_AUTH;
    }
    if (child->state == 0 && !create) {
        registry_leave();
        *result = PXII_INVALID_HANDLE;
        return SQLITE_NOTFOUND;
    }
    create_mode = child->state == 0 ? (create ? 2 : 0) : 0;
    result_code = relative_open(binding, name, create_mode, result);
    if (result_code == SQLITE_OK) {
        result_code = handle_identity(*result, &observed);
        if (result_code == SQLITE_OK && child->state == 0) {
            child->identity = observed;
            child->state = 1;
        } else if (result_code == SQLITE_OK && !identity_equal(&child->identity, &observed)) {
            result_code = SQLITE_CANTOPEN;
        }
    }
    registry_leave();
    if (result_code != SQLITE_OK) {
        handle_close(*result);
        *result = PXII_INVALID_HANDLE;
    }
    return result_code;
}

static int initialize_child_binding(PxiiBinding *binding, PxiiBoundChild *child) {
    char name[PXII_NAME_MAX + 16];
    PxiiHandle handle = PXII_INVALID_HANDLE;
    int result;
    (void)snprintf(name, sizeof(name), "%s%s", binding->basename, child->suffix);
    result = relative_open(binding, name, 0, &handle);
    if (result == SQLITE_NOTFOUND) {
        child->state = 0;
        return SQLITE_OK;
    }
    if (result != SQLITE_OK) {
        return result;
    }
    result = handle_identity(handle, &child->identity);
    handle_close(handle);
    if (result == SQLITE_OK) {
        child->state = 1;
    }
    return result;
}

static int verify_file_namespace(PxiiFile *file) {
    PxiiHandle observed_handle = PXII_INVALID_HANDLE;
    PxiiIdentity observed_identity;
    int result;
    if (file->is_temp || file->binding == NULL) {
        return SQLITE_OK;
    }
    if (file->role_suffix == NULL) {
        result = relative_open(file->binding, file->binding->basename, 0, &observed_handle);
    } else {
        result = binding_open_companion(
            file->binding, file->role_suffix, 0, &observed_handle
        );
    }
    if (result == SQLITE_OK) {
        result = handle_identity(observed_handle, &observed_identity);
    }
    handle_close(observed_handle);
    if (result != SQLITE_OK || !identity_equal(&file->identity, &observed_identity)) {
        return SQLITE_IOERR;
    }
    return SQLITE_OK;
}

static int verify_shm_namespace(PxiiFile *file) {
    PxiiHandle observed = PXII_INVALID_HANDLE;
    PxiiIdentity identity;
    int result;
    if (!handle_valid(file->shm_handle)) {
        return SQLITE_OK;
    }
    result = binding_open_companion(file->binding, "-shm", 0, &observed);
    if (result == SQLITE_OK) {
        result = handle_identity(observed, &identity);
    }
    handle_close(observed);
    return result == SQLITE_OK && identity_equal(&file->shm_identity, &identity)
        ? SQLITE_OK : SQLITE_IOERR_SHMOPEN;
}

static int open_anonymous_temp(PxiiHandle *result) {
    static const char hex[] = "0123456789abcdef";
    unsigned char random_bytes[16];
    char name[sizeof(random_bytes) * 2 + 6];
    int attempt;
    size_t index;
    if (!handle_valid(g_temp_root)) {
        return SQLITE_CANTOPEN;
    }
    for (attempt = 0; attempt < 32; attempt += 1) {
        (void)g_stock_vfs->xRandomness(
            g_stock_vfs, (int)sizeof(random_bytes), (char *)random_bytes
        );
        memcpy(name, "pxii-", 5);
        for (index = 0; index < sizeof(random_bytes); index += 1) {
            name[5 + index * 2] = hex[random_bytes[index] >> 4];
            name[6 + index * 2] = hex[random_bytes[index] & 0x0f];
        }
        name[5 + sizeof(random_bytes) * 2] = '\0';
#if defined(_WIN32)
        if (windows_relative_open(g_temp_root, name, 4, result) == SQLITE_OK) {
            return SQLITE_OK;
        }
#else
        *result = openat(
            g_temp_root,
            name,
            O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_CREAT | O_EXCL,
            0600
        );
        if (*result >= 0) {
            if (unlinkat(g_temp_root, name, 0) != 0) {
                handle_close(*result);
                *result = PXII_INVALID_HANDLE;
                return SQLITE_IOERR_DELETE;
            }
            return SQLITE_OK;
        }
#endif
    }
    return SQLITE_CANTOPEN;
}

static int pxii_open(
    sqlite3_vfs *vfs,
    const char *name,
    sqlite3_file *file,
    int flags,
    int *out_flags
) {
    PxiiFile *pxii = (PxiiFile *)file;
    PxiiBinding *binding = NULL;
    const char *suffix = NULL;
    int primary = flags & (
        SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_TEMP_DB |
        SQLITE_OPEN_TEMP_JOURNAL | SQLITE_OPEN_TRANSIENT_DB | SQLITE_OPEN_SUBJOURNAL |
        SQLITE_OPEN_SUPER_JOURNAL | SQLITE_OPEN_WAL
    );
    int result = SQLITE_OK;
    (void)vfs;
    trace_event("open", flags, primary);
    memset(pxii, 0, sizeof(*pxii));
    pxii->handle = PXII_INVALID_HANDLE;
    pxii->shm_handle = PXII_INVALID_HANDLE;
    if (primary == 0 || (primary & (primary - 1)) != 0 || primary == SQLITE_OPEN_SUPER_JOURNAL) {
        return SQLITE_CANTOPEN;
    }
    if ((flags & SQLITE_OPEN_MEMORY) != 0) {
        if (name != NULL) {
            return SQLITE_CANTOPEN;
        }
        pxii->is_temp = 1;
        pxii->is_memory = 1;
        pxii->delete_on_close = 1;
    } else if (primary == SQLITE_OPEN_TEMP_DB || primary == SQLITE_OPEN_TEMP_JOURNAL ||
        primary == SQLITE_OPEN_TRANSIENT_DB || primary == SQLITE_OPEN_SUBJOURNAL) {
        result = open_anonymous_temp(&pxii->handle);
        pxii->is_temp = 1;
        pxii->delete_on_close = 1;
    } else {
        result = parse_virtual_name(name, &binding, &suffix);
        if (result != SQLITE_OK) {
            return result;
        }
        pxii->binding = binding;
        if (binding->open_delay_ms > 0) {
            (void)g_stock_vfs->xSleep(g_stock_vfs, binding->open_delay_ms * 1000);
        }
        if (primary == SQLITE_OPEN_MAIN_DB) {
            if (*suffix != '\0' && *suffix != '?') {
                result = SQLITE_CANTOPEN;
            } else {
                PxiiHandle current = PXII_INVALID_HANDLE;
                PxiiIdentity current_identity;
                result = relative_open(binding, binding->basename, 0, &current);
                if (result == SQLITE_OK) {
                    result = handle_identity(current, &current_identity);
                }
                if (result == SQLITE_OK &&
                    !identity_equal(&binding->main_identity, &current_identity)) {
                    result = SQLITE_CANTOPEN;
                }
                if (result == SQLITE_OK) {
                    pxii->handle = current;
                    current = PXII_INVALID_HANDLE;
                    pxii->identity = binding->main_identity;
                }
                handle_close(current);
            }
        } else if (primary == SQLITE_OPEN_MAIN_JOURNAL) {
            result = binding_open_companion(binding, "-journal", 1, &pxii->handle);
            pxii->role_suffix = "-journal";
        } else if (primary == SQLITE_OPEN_WAL) {
            result = binding_open_companion(binding, "-wal", 1, &pxii->handle);
            pxii->role_suffix = "-wal";
        }
        if (result == SQLITE_OK && primary != SQLITE_OPEN_MAIN_DB) {
            result = handle_identity(pxii->handle, &pxii->identity);
        }
    }
    if (result != SQLITE_OK) {
        binding_release(binding);
        pxii->binding = NULL;
        handle_close(pxii->handle);
        pxii->handle = PXII_INVALID_HANDLE;
        trace_event("open-failed", result, primary);
        return result;
    }
    pxii->base.pMethods = &g_io_methods;
    if (out_flags != NULL) {
        *out_flags = flags;
    }
    trace_event("open-ok", flags, primary);
    return SQLITE_OK;
}

static int pxii_delete(sqlite3_vfs *vfs, const char *name, int sync_dir) {
    PxiiBinding *binding = NULL;
    const char *suffix = NULL;
#if defined(_WIN32)
    PxiiHandle handle = PXII_INVALID_HANDLE;
    PxiiIdentity expected_identity;
#endif
    int result;
    (void)vfs;
#if defined(_WIN32)
    (void)sync_dir;
#else
    (void)sync_dir;
#endif
    result = parse_virtual_name(name, &binding, &suffix);
    if (result != SQLITE_OK) {
        return result;
    }
    if (strcmp(suffix, "-journal") != 0 && strcmp(suffix, "-wal") != 0 && strcmp(suffix, "-shm") != 0) {
        binding_release(binding);
        return SQLITE_IOERR_DELETE;
    }
#if !defined(_WIN32)
    trace_event("pxii_posix_delete_deferred", PXII_POSIX_DELETE_DEFERRED, 0);
    binding_release(binding);
    return PXII_POSIX_DELETE_DEFERRED;
#else
    registry_enter();
    {
        PxiiBoundChild *child = binding_child(binding, suffix);
        if (child == NULL || child->state == 0) {
            registry_leave();
            binding_release(binding);
            return SQLITE_IOERR_DELETE_NOENT;
        }
        expected_identity = child->identity;
    }
    registry_leave();
    result = binding_open_companion(binding, suffix, 0, &handle);
    if (result != SQLITE_OK) {
        binding_release(binding);
        return SQLITE_IOERR_DELETE_NOENT;
    }
    handle_close(handle);
    handle = PXII_INVALID_HANDLE;
    result = binding_open_companion(binding, suffix, 0, &handle);
    if (result == SQLITE_OK) {
        PxiiIdentity observed;
        result = handle_identity(handle, &observed);
        if (result == SQLITE_OK && !identity_equal(&expected_identity, &observed)) {
            result = SQLITE_IOERR_DELETE;
        }
    }
    handle_close(handle);
    handle = PXII_INVALID_HANDLE;
    if (result != SQLITE_OK) {
        binding_release(binding);
        return SQLITE_IOERR_DELETE;
    }
    {
        FILE_DISPOSITION_INFO disposition;
        char child_name[PXII_NAME_MAX + 16];
        PxiiIdentity delete_identity;
        handle_close(handle);
        handle = PXII_INVALID_HANDLE;
        (void)snprintf(child_name, sizeof(child_name), "%s%s", binding->basename, suffix);
        result = relative_open(binding, child_name, 3, &handle);
        if (result == SQLITE_OK) {
            result = handle_identity(handle, &delete_identity);
        }
        if (result != SQLITE_OK || !identity_equal(&expected_identity, &delete_identity)) {
            handle_close(handle);
            binding_release(binding);
            return SQLITE_IOERR_DELETE;
        }
        disposition.DeleteFile = TRUE;
        result = SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition))
            ? SQLITE_OK : SQLITE_IOERR_DELETE;
    }
    handle_close(handle);
    if (result == SQLITE_OK) {
        PxiiBoundChild *child = binding_child(binding, suffix);
        registry_enter();
        child->state = 0;
        memset(&child->identity, 0, sizeof(child->identity));
        registry_leave();
    }
    binding_release(binding);
    return result;
#endif
}

static int pxii_access(sqlite3_vfs *vfs, const char *name, int flags, int *result_out) {
    PxiiBinding *binding = NULL;
    const char *suffix = NULL;
    PxiiHandle handle = PXII_INVALID_HANDLE;
    int result;
    (void)vfs;
    (void)flags;
    *result_out = 0;
    result = parse_virtual_name(name, &binding, &suffix);
    if (result != SQLITE_OK) {
        return SQLITE_OK;
    }
    if (*suffix == '\0' || *suffix == '?') {
        *result_out = !binding_is_revoked(binding);
    } else if (strcmp(suffix, "-journal") == 0 || strcmp(suffix, "-wal") == 0 || strcmp(suffix, "-shm") == 0) {
        if (binding_open_companion(binding, suffix, 0, &handle) == SQLITE_OK) {
            *result_out = 1;
            handle_close(handle);
        }
    }
    binding_release(binding);
    return SQLITE_OK;
}

static int pxii_full_pathname(sqlite3_vfs *vfs, const char *name, int length, char *output) {
    size_t required;
    (void)vfs;
    if (name == NULL || strncmp(name, "pxii-", 5) != 0) {
        return SQLITE_CANTOPEN;
    }
    required = strlen(name) + 1;
    if (required > (size_t)length) {
        return SQLITE_CANTOPEN;
    }
    memcpy(output, name, required);
    return SQLITE_OK;
}

static void *pxii_dl_open(sqlite3_vfs *vfs, const char *name) {
    (void)vfs;
    return g_stock_vfs->xDlOpen(g_stock_vfs, name);
}
static void pxii_dl_error(sqlite3_vfs *vfs, int length, char *message) {
    (void)vfs;
    g_stock_vfs->xDlError(g_stock_vfs, length, message);
}
static void (*pxii_dl_sym(sqlite3_vfs *vfs, void *handle, const char *symbol))(void) {
    (void)vfs;
    return g_stock_vfs->xDlSym(g_stock_vfs, handle, symbol);
}
static void pxii_dl_close(sqlite3_vfs *vfs, void *handle) {
    (void)vfs;
    g_stock_vfs->xDlClose(g_stock_vfs, handle);
}
static int pxii_randomness(sqlite3_vfs *vfs, int length, char *output) {
    (void)vfs;
    return g_stock_vfs->xRandomness(g_stock_vfs, length, output);
}
static int pxii_sleep(sqlite3_vfs *vfs, int microseconds) {
    (void)vfs;
    return g_stock_vfs->xSleep(g_stock_vfs, microseconds);
}
static int pxii_current_time(sqlite3_vfs *vfs, double *value) {
    (void)vfs;
    return g_stock_vfs->xCurrentTime(g_stock_vfs, value);
}
static int pxii_get_last_error(sqlite3_vfs *vfs, int length, char *message) {
    (void)vfs;
    return g_stock_vfs->xGetLastError(g_stock_vfs, length, message);
}
static int pxii_current_time_int64(sqlite3_vfs *vfs, sqlite3_int64 *value) {
    (void)vfs;
    return g_stock_vfs->iVersion >= 2 && g_stock_vfs->xCurrentTimeInt64 != NULL
        ? g_stock_vfs->xCurrentTimeInt64(g_stock_vfs, value)
        : SQLITE_ERROR;
}
static int pxii_set_system_call(sqlite3_vfs *vfs, const char *name, sqlite3_syscall_ptr call) {
    (void)vfs;
    return g_stock_vfs->iVersion >= 3 && g_stock_vfs->xSetSystemCall != NULL
        ? g_stock_vfs->xSetSystemCall(g_stock_vfs, name, call)
        : SQLITE_NOTFOUND;
}
static sqlite3_syscall_ptr pxii_get_system_call(sqlite3_vfs *vfs, const char *name) {
    (void)vfs;
    return g_stock_vfs->iVersion >= 3 && g_stock_vfs->xGetSystemCall != NULL
        ? g_stock_vfs->xGetSystemCall(g_stock_vfs, name)
        : NULL;
}
static const char *pxii_next_system_call(sqlite3_vfs *vfs, const char *name) {
    (void)vfs;
    return g_stock_vfs->iVersion >= 3 && g_stock_vfs->xNextSystemCall != NULL
        ? g_stock_vfs->xNextSystemCall(g_stock_vfs, name)
        : NULL;
}

static int pxii_close(sqlite3_file *file) {
    PxiiFile *pxii = (PxiiFile *)file;
    int result = pxii_shm_unmap(file, 0);
    sqlite3_free(pxii->memory);
    pxii->memory = NULL;
    handle_close(pxii->handle);
    pxii->handle = PXII_INVALID_HANDLE;
    binding_release(pxii->binding);
    pxii->binding = NULL;
    return result;
}

static int pxii_read(sqlite3_file *file, void *buffer, int amount, sqlite3_int64 offset) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        sqlite3_int64 available = pxii->memory_size - offset;
        int copied = available > amount ? amount : (available > 0 ? (int)available : 0);
        if (copied > 0) {
            memcpy(buffer, pxii->memory + offset, (size_t)copied);
        }
        if (copied < amount) {
            memset((char *)buffer + copied, 0, (size_t)(amount - copied));
            return SQLITE_IOERR_SHORT_READ;
        }
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_READ;
    }
#if defined(_WIN32)
    OVERLAPPED overlapped;
    DWORD read_count = 0;
    memset(&overlapped, 0, sizeof(overlapped));
    overlapped.Offset = (DWORD)(offset & 0xffffffff);
    overlapped.OffsetHigh = (DWORD)(((uint64_t)offset >> 32) & 0xffffffff);
    if (!ReadFile(pxii->handle, buffer, (DWORD)amount, &read_count, &overlapped)) {
        DWORD error = GetLastError();
        if (error == ERROR_IO_PENDING &&
            GetOverlappedResult(pxii->handle, &overlapped, &read_count, TRUE)) {
            error = ERROR_SUCCESS;
        } else if (error == ERROR_IO_PENDING) {
            error = GetLastError();
        }
        if (error == ERROR_HANDLE_EOF) {
            read_count = 0;
            error = ERROR_SUCCESS;
        }
        if (error != ERROR_SUCCESS) {
            pxii->last_errno = (int)error;
            trace_event("read-error", error, offset);
            return SQLITE_IOERR_READ;
        }
    }
#else
    ssize_t read_count = pread(pxii->handle, buffer, (size_t)amount, (off_t)offset);
    if (read_count < 0) {
        pxii->last_errno = errno;
        return SQLITE_IOERR_READ;
    }
#endif
    if ((sqlite3_int64)read_count < amount) {
        memset((char *)buffer + read_count, 0, (size_t)amount - (size_t)read_count);
        trace_event("read-short", read_count, amount);
        return SQLITE_IOERR_SHORT_READ;
    }
    return SQLITE_OK;
}

static int pxii_write(sqlite3_file *file, const void *buffer, int amount, sqlite3_int64 offset) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        sqlite3_int64 required = offset + amount;
        if (offset < 0 || amount < 0 || required < offset) {
            return SQLITE_IOERR_WRITE;
        }
        if (required > pxii->memory_capacity) {
            sqlite3_int64 capacity = pxii->memory_capacity > 0 ? pxii->memory_capacity : 4096;
            unsigned char *resized;
            while (capacity < required) {
                if (capacity > INT64_MAX / 2) {
                    capacity = required;
                    break;
                }
                capacity *= 2;
            }
            resized = (unsigned char *)sqlite3_realloc64(pxii->memory, (sqlite3_uint64)capacity);
            if (resized == NULL) {
                return SQLITE_NOMEM;
            }
            if (capacity > pxii->memory_capacity) {
                memset(
                    resized + pxii->memory_capacity,
                    0,
                    (size_t)(capacity - pxii->memory_capacity)
                );
            }
            pxii->memory = resized;
            pxii->memory_capacity = capacity;
        }
        memcpy(pxii->memory + offset, buffer, (size_t)amount);
        if (required > pxii->memory_size) {
            pxii->memory_size = required;
        }
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_WRITE;
    }
#if defined(_WIN32)
    OVERLAPPED overlapped;
    DWORD write_count = 0;
    memset(&overlapped, 0, sizeof(overlapped));
    overlapped.Offset = (DWORD)(offset & 0xffffffff);
    overlapped.OffsetHigh = (DWORD)(((uint64_t)offset >> 32) & 0xffffffff);
    if (!WriteFile(pxii->handle, buffer, (DWORD)amount, &write_count, &overlapped)) {
        DWORD error = GetLastError();
        if (error == ERROR_IO_PENDING &&
            GetOverlappedResult(pxii->handle, &overlapped, &write_count, TRUE)) {
            error = ERROR_SUCCESS;
        } else if (error == ERROR_IO_PENDING) {
            error = GetLastError();
        }
        if (error != ERROR_SUCCESS) {
            pxii->last_errno = (int)error;
            trace_event("write-error", error, offset);
            return SQLITE_IOERR_WRITE;
        }
    }
#else
    ssize_t write_count = pwrite(pxii->handle, buffer, (size_t)amount, (off_t)offset);
    if (write_count < 0) {
        pxii->last_errno = errno;
        return SQLITE_IOERR_WRITE;
    }
#endif
    return (sqlite3_int64)write_count == amount ? SQLITE_OK : SQLITE_IOERR_WRITE;
}

static int pxii_truncate(sqlite3_file *file, sqlite3_int64 size) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        if (size < 0 || size > pxii->memory_capacity) {
            return size < 0 ? SQLITE_IOERR_TRUNCATE : SQLITE_OK;
        }
        pxii->memory_size = size;
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_TRUNCATE;
    }
#if defined(_WIN32)
    LARGE_INTEGER position;
    position.QuadPart = size;
    {
        int result = SetFilePointerEx(pxii->handle, position, NULL, FILE_BEGIN) && SetEndOfFile(pxii->handle)
            ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
        trace_event("truncate", size, result);
        return result;
    }
#else
    return ftruncate(pxii->handle, (off_t)size) == 0 ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
#endif
}

static int pxii_sync(sqlite3_file *file, int flags) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_FSYNC;
    }
    (void)flags;
#if defined(_WIN32)
    {
        int result = FlushFileBuffers(pxii->handle) ? SQLITE_OK : SQLITE_IOERR_FSYNC;
        trace_event("sync", flags, result);
        return result;
    }
#else
    return fsync(pxii->handle) == 0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
#endif
}

static int pxii_file_size(sqlite3_file *file, sqlite3_int64 *size) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        *size = pxii->memory_size;
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_FSTAT;
    }
#if defined(_WIN32)
    LARGE_INTEGER value;
    if (!GetFileSizeEx(pxii->handle, &value)) {
        return SQLITE_IOERR_FSTAT;
    }
    *size = value.QuadPart;
#else
    struct stat info;
    if (fstat(pxii->handle, &info) != 0) {
        return SQLITE_IOERR_FSTAT;
    }
    *size = (sqlite3_int64)info.st_size;
#endif
    trace_event("size", *size, 0);
    return SQLITE_OK;
}

static int native_lock(PxiiHandle handle, sqlite3_int64 offset, sqlite3_int64 length, int exclusive, int unlock) {
#if defined(_WIN32)
    OVERLAPPED overlapped;
    DWORD flags = exclusive ? LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY : LOCKFILE_FAIL_IMMEDIATELY;
    memset(&overlapped, 0, sizeof(overlapped));
    overlapped.Offset = (DWORD)(offset & 0xffffffff);
    overlapped.OffsetHigh = (DWORD)(((uint64_t)offset >> 32) & 0xffffffff);
    if (unlock) {
        return UnlockFileEx(handle, 0, (DWORD)length, (DWORD)((uint64_t)length >> 32), &overlapped)
            ? SQLITE_OK : SQLITE_IOERR_UNLOCK;
    }
    return LockFileEx(handle, flags, 0, (DWORD)length, (DWORD)((uint64_t)length >> 32), &overlapped)
        ? SQLITE_OK : SQLITE_BUSY;
#else
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = unlock ? F_UNLCK : (exclusive ? F_WRLCK : F_RDLCK);
    lock.l_whence = SEEK_SET;
    lock.l_start = (off_t)offset;
    lock.l_len = (off_t)length;
#if defined(F_OFD_SETLK)
    if (fcntl(handle, F_OFD_SETLK, &lock) == 0) {
#else
    if (fcntl(handle, F_SETLK, &lock) == 0) {
#endif
        return SQLITE_OK;
    }
    return (errno == EACCES || errno == EAGAIN) ? SQLITE_BUSY : SQLITE_IOERR_LOCK;
#endif
}

static int pxii_lock(sqlite3_file *file, int level) {
    PxiiFile *pxii = (PxiiFile *)file;
    int result = SQLITE_OK;
    if (pxii->is_memory) {
        pxii->lock_level = level;
        return SQLITE_OK;
    }
    if (verify_file_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_LOCK;
    }
    if (level <= pxii->lock_level) {
        return SQLITE_OK;
    }
    if (pxii->lock_level < SQLITE_LOCK_SHARED && level >= SQLITE_LOCK_SHARED) {
        result = native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 0, 0);
    }
    if (result == SQLITE_OK && pxii->lock_level < SQLITE_LOCK_RESERVED && level >= SQLITE_LOCK_RESERVED) {
        result = native_lock(pxii->handle, PXII_RESERVED_BYTE, 1, 1, 0);
    }
    if (result == SQLITE_OK && pxii->lock_level < SQLITE_LOCK_PENDING && level >= SQLITE_LOCK_PENDING) {
        result = native_lock(pxii->handle, PXII_PENDING_BYTE, 1, 1, 0);
    }
    if (result == SQLITE_OK && level >= SQLITE_LOCK_EXCLUSIVE) {
        (void)native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 0, 1);
        result = native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 1, 0);
        if (result != SQLITE_OK) {
            (void)native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 0, 0);
        }
    }
    if (result == SQLITE_OK) {
        pxii->lock_level = level;
    }
    trace_event("lock", level, result);
    return result;
}

static int pxii_unlock(sqlite3_file *file, int level) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        pxii->lock_level = level;
        return SQLITE_OK;
    }
    if (pxii->lock_level >= SQLITE_LOCK_EXCLUSIVE && level < SQLITE_LOCK_EXCLUSIVE) {
        (void)native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 1, 1);
        if (level >= SQLITE_LOCK_SHARED) {
            (void)native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 0, 0);
        }
    }
    if (pxii->lock_level >= SQLITE_LOCK_PENDING && level < SQLITE_LOCK_PENDING) {
        (void)native_lock(pxii->handle, PXII_PENDING_BYTE, 1, 1, 1);
    }
    if (pxii->lock_level >= SQLITE_LOCK_RESERVED && level < SQLITE_LOCK_RESERVED) {
        (void)native_lock(pxii->handle, PXII_RESERVED_BYTE, 1, 1, 1);
    }
    if (pxii->lock_level >= SQLITE_LOCK_SHARED && level < SQLITE_LOCK_SHARED) {
        (void)native_lock(pxii->handle, PXII_SHARED_FIRST, PXII_SHARED_SIZE, 0, 1);
    }
    pxii->lock_level = level;
    return SQLITE_OK;
}

static int pxii_check_reserved_lock(sqlite3_file *file, int *result) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (pxii->is_memory) {
        *result = pxii->lock_level >= SQLITE_LOCK_RESERVED;
        return SQLITE_OK;
    }
    int lock_result = native_lock(pxii->handle, PXII_RESERVED_BYTE, 1, 1, 0);
    if (lock_result == SQLITE_OK) {
        (void)native_lock(pxii->handle, PXII_RESERVED_BYTE, 1, 1, 1);
        *result = 0;
        return SQLITE_OK;
    }
    if (lock_result == SQLITE_BUSY) {
        *result = 1;
        return SQLITE_OK;
    }
    return lock_result;
}

static int pxii_file_control(sqlite3_file *file, int operation, void *argument) {
    PxiiFile *pxii = (PxiiFile *)file;
    if (operation == SQLITE_FCNTL_LOCKSTATE) {
        *(int *)argument = pxii->lock_level;
        return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_LAST_ERRNO) {
        *(int *)argument = pxii->last_errno;
        return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_VFSNAME) {
        *(char **)argument = sqlite3_mprintf("pxii");
        return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_HAS_MOVED) {
        *(int *)argument = 0;
        return SQLITE_OK;
    }
    if (operation == SQLITE_FCNTL_SYNC || operation == SQLITE_FCNTL_COMMIT_PHASETWO ||
        operation == SQLITE_FCNTL_SIZE_HINT || operation == SQLITE_FCNTL_PERSIST_WAL ||
        operation == SQLITE_FCNTL_POWERSAFE_OVERWRITE) {
        return SQLITE_OK;
    }
    trace_event("file-control-miss", operation, 0);
    return SQLITE_NOTFOUND;
}

static int pxii_sector_size(sqlite3_file *file) {
    (void)file;
    return 4096;
}
static int pxii_device_characteristics(sqlite3_file *file) {
    (void)file;
    return SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
}

static int ensure_shm_handle(PxiiFile *pxii) {
    if (handle_valid(pxii->shm_handle)) {
        return SQLITE_OK;
    }
    if (pxii->binding == NULL || binding_is_revoked(pxii->binding)) {
        return SQLITE_AUTH;
    }
    {
        int result = binding_open_companion(pxii->binding, "-shm", 1, &pxii->shm_handle);
        if (result == SQLITE_OK) {
            result = handle_identity(pxii->shm_handle, &pxii->shm_identity);
            if (result != SQLITE_OK) {
                handle_close(pxii->shm_handle);
                pxii->shm_handle = PXII_INVALID_HANDLE;
            }
        }
        return result;
    }
}

static int pxii_shm_map(
    sqlite3_file *file,
    int page,
    int page_size,
    int extend,
    void volatile **out
) {
    PxiiFile *pxii = (PxiiFile *)file;
    sqlite3_int64 required = (sqlite3_int64)(page + 1) * page_size;
    if (page < 0 || page >= PXII_SHM_MAPS || page_size <= 0) {
        return SQLITE_IOERR_SHMMAP;
    }
    trace_event("shm-map-enter", page, extend);
    if (pxii->maps[page].view != NULL) {
        if (verify_shm_namespace(pxii) != SQLITE_OK) {
            return SQLITE_IOERR_SHMMAP;
        }
        *out = pxii->maps[page].view;
        return SQLITE_OK;
    }
    if (ensure_shm_handle(pxii) != SQLITE_OK) {
        trace_event("shm-open-error", page, 0);
        return SQLITE_IOERR_SHMOPEN;
    }
    if (verify_shm_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_SHMLOCK;
    }
#if defined(_WIN32)
    {
        LARGE_INTEGER current;
        if (!GetFileSizeEx(pxii->shm_handle, &current)) {
            trace_event("shm-size-error", GetLastError(), required);
            return SQLITE_IOERR_SHMSIZE;
        }
        if (current.QuadPart < required) {
            LARGE_INTEGER position;
            if (!extend) {
                *out = NULL;
                return SQLITE_OK;
            }
            position.QuadPart = required;
            if (!SetFilePointerEx(pxii->shm_handle, position, NULL, FILE_BEGIN) || !SetEndOfFile(pxii->shm_handle)) {
                trace_event("shm-extend-error", GetLastError(), required);
                return SQLITE_IOERR_SHMSIZE;
            }
        }
    }
#else
    {
        struct stat info;
        if (fstat(pxii->shm_handle, &info) != 0) {
            return SQLITE_IOERR_SHMSIZE;
        }
        if (info.st_size < required) {
            if (!extend) {
                *out = NULL;
                return SQLITE_OK;
            }
            if (ftruncate(pxii->shm_handle, (off_t)required) != 0) {
                return SQLITE_IOERR_SHMSIZE;
            }
        }
    }
#endif
#if defined(_WIN32)
    {
        SYSTEM_INFO system_info;
        sqlite3_int64 offset = (sqlite3_int64)page * page_size;
        sqlite3_int64 aligned;
        size_t delta;
        GetSystemInfo(&system_info);
        aligned = offset - (offset % system_info.dwAllocationGranularity);
        delta = (size_t)(offset - aligned);
        pxii->maps[page].mapping = CreateFileMappingW(pxii->shm_handle, NULL, PAGE_READWRITE, 0, 0, NULL);
        if (pxii->maps[page].mapping == NULL) {
            trace_event("shm-mapping-error", GetLastError(), page);
            return SQLITE_IOERR_SHMMAP;
        }
        pxii->maps[page].base = MapViewOfFile(
            pxii->maps[page].mapping, FILE_MAP_ALL_ACCESS,
            (DWORD)((uint64_t)aligned >> 32), (DWORD)(aligned & 0xffffffff),
            (SIZE_T)page_size + delta
        );
        if (pxii->maps[page].base == NULL) {
            CloseHandle(pxii->maps[page].mapping);
            pxii->maps[page].mapping = NULL;
            trace_event("shm-view-error", GetLastError(), page);
            return SQLITE_IOERR_SHMMAP;
        }
        pxii->maps[page].view = (char *)pxii->maps[page].base + delta;
        pxii->maps[page].length = (size_t)page_size + delta;
    }
#else
    pxii->maps[page].base = mmap(
        NULL, (size_t)page_size, PROT_READ | PROT_WRITE, MAP_SHARED,
        pxii->shm_handle, (off_t)page * page_size
    );
    if (pxii->maps[page].base == MAP_FAILED) {
        pxii->maps[page].base = NULL;
        return SQLITE_IOERR_SHMMAP;
    }
    pxii->maps[page].view = pxii->maps[page].base;
    pxii->maps[page].length = (size_t)page_size;
#endif
    *out = pxii->maps[page].view;
    trace_event("shm-map", page, page_size);
    return SQLITE_OK;
}

static int pxii_shm_lock(sqlite3_file *file, int offset, int count, int flags) {
    PxiiFile *pxii = (PxiiFile *)file;
    int unlock = (flags & SQLITE_SHM_UNLOCK) != 0;
    int exclusive = (flags & SQLITE_SHM_EXCLUSIVE) != 0;
    if (verify_shm_namespace(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_SHMLOCK;
    }
    if (ensure_shm_handle(pxii) != SQLITE_OK) {
        return SQLITE_IOERR_SHMLOCK;
    }
    {
        int result = native_lock(pxii->shm_handle, offset, count, exclusive, unlock);
        trace_event("shm-lock", flags, result);
        return result;
    }
}

static void pxii_shm_barrier(sqlite3_file *file) {
    (void)file;
#if defined(_WIN32)
    MemoryBarrier();
#else
    atomic_thread_fence(memory_order_seq_cst);
#endif
}

static int pxii_shm_unmap(sqlite3_file *file, int delete_flag) {
    PxiiFile *pxii = (PxiiFile *)file;
    int index;
    for (index = 0; index < PXII_SHM_MAPS; index += 1) {
        if (pxii->maps[index].base != NULL) {
#if defined(_WIN32)
            UnmapViewOfFile(pxii->maps[index].base);
            CloseHandle(pxii->maps[index].mapping);
            pxii->maps[index].mapping = NULL;
#else
            (void)munmap(pxii->maps[index].base, pxii->maps[index].length);
#endif
            pxii->maps[index].base = NULL;
            pxii->maps[index].view = NULL;
        }
    }
    handle_close(pxii->shm_handle);
    pxii->shm_handle = PXII_INVALID_HANDLE;
    if (delete_flag && pxii->binding != NULL) {
        char virtual_name[PXII_TOKEN_MAX + 16];
        (void)snprintf(virtual_name, sizeof(virtual_name), "pxii-%s-shm", pxii->binding->token);
        return pxii_delete(&g_vfs, virtual_name, 0);
    }
    return SQLITE_OK;
}

static int pxii_fetch(sqlite3_file *file, sqlite3_int64 offset, int amount, void **out) {
    (void)file;
    (void)offset;
    (void)amount;
    *out = NULL;
    return SQLITE_OK;
}
static int pxii_unfetch(sqlite3_file *file, sqlite3_int64 offset, void *value) {
    (void)file;
    (void)offset;
    (void)value;
    return SQLITE_OK;
}

static void sql_bind(sqlite3_context *context, int count, sqlite3_value **values) {
    const char *token;
    const char *basename;
    PxiiHandle parent;
    PxiiHandle main_file;
    PxiiBinding *binding;
    int result;
    int create_authority;
    int companion_exists = 0;
    if (count != 5) {
        sqlite3_result_error(context, "pxii_bind requires five arguments", -1);
        return;
    }
    token = (const char *)sqlite3_value_text(values[0]);
    parent = (PxiiHandle)(intptr_t)sqlite3_value_int64(values[1]);
    main_file = (PxiiHandle)(intptr_t)sqlite3_value_int64(values[2]);
    basename = (const char *)sqlite3_value_text(values[3]);
    create_authority = sqlite3_value_int(values[4]);
    if (token == NULL || strlen(token) == 0 || strlen(token) >= PXII_TOKEN_MAX || !exact_basename(basename)) {
        sqlite3_result_error(context, "invalid pxii authority binding", -1);
        return;
    }
    binding = (PxiiBinding *)sqlite3_malloc64(sizeof(*binding));
    if (binding == NULL) {
        sqlite3_result_error_nomem(context);
        return;
    }
    memset(binding, 0, sizeof(*binding));
    binding->parent = PXII_INVALID_HANDLE;
    binding->main_file = PXII_INVALID_HANDLE;
    binding->journal.suffix = "-journal";
    binding->wal.suffix = "-wal";
    binding->shm.suffix = "-shm";
    (void)snprintf(binding->token, sizeof(binding->token), "%s", token);
    (void)snprintf(binding->basename, sizeof(binding->basename), "%s", basename);
    result = handle_duplicate(parent, &binding->parent);
    if (result == SQLITE_OK) {
        result = handle_duplicate(main_file, &binding->main_file);
    }
    if (result == SQLITE_OK) {
        result = handle_identity(binding->main_file, &binding->main_identity);
    }
    if (result == SQLITE_OK) {
        result = initialize_child_binding(binding, &binding->journal);
    }
    if (result == SQLITE_OK) {
        result = initialize_child_binding(binding, &binding->wal);
    }
    if (result == SQLITE_OK) {
        result = initialize_child_binding(binding, &binding->shm);
    }
    if (result == SQLITE_OK && create_authority &&
        (binding->journal.state != 0 || binding->wal.state != 0 || binding->shm.state != 0)) {
        companion_exists = 1;
        result = SQLITE_CANTOPEN;
    }
    if (result != SQLITE_OK) {
        handle_close(binding->parent);
        handle_close(binding->main_file);
        sqlite3_free(binding);
        if (companion_exists) {
            sqlite3_result_error(context, "pxii create authority companion already exists", -1);
        } else {
            sqlite3_result_error(context, "cannot duplicate pxii authority", -1);
        }
        return;
    }
    registry_enter();
    if (binding_find_locked(token, strlen(token)) != NULL) {
        registry_leave();
        handle_close(binding->parent);
        handle_close(binding->main_file);
        sqlite3_free(binding);
        sqlite3_result_error(context, "duplicate pxii authority token", -1);
        return;
    }
    binding->next = g_bindings;
    g_bindings = binding;
    registry_leave();
    sqlite3_result_int(context, 1);
}

static void sql_revoke(sqlite3_context *context, int count, sqlite3_value **values) {
    const char *token;
    PxiiBinding *binding;
    int found;
    if (count != 1) {
        sqlite3_result_error(context, "pxii_revoke requires one argument", -1);
        return;
    }
    token = (const char *)sqlite3_value_text(values[0]);
    if (token == NULL) {
        sqlite3_result_int(context, 0);
        return;
    }
    registry_enter();
    binding = binding_find_locked(token, strlen(token));
    found = binding != NULL;
    if (binding != NULL) {
        binding->revoked = 1;
        binding_close_if_terminal_locked(binding);
    }
    registry_leave();
    sqlite3_result_int(context, found);
}

static void sql_source_id(sqlite3_context *context, int count, sqlite3_value **values) {
    (void)count;
    (void)values;
    sqlite3_result_text(context, sqlite3_sourceid(), -1, SQLITE_TRANSIENT);
}

static void sql_vfs_name(sqlite3_context *context, int count, sqlite3_value **values) {
    (void)count;
    (void)values;
    sqlite3_result_text(context, "pxii-vfs", -1, SQLITE_STATIC);
}

static void sql_live_references(sqlite3_context *context, int count, sqlite3_value **values) {
    const char *token;
    PxiiBinding *binding;
    int references = -1;
    if (count != 1) {
        sqlite3_result_error(context, "pxii_live_references requires one argument", -1);
        return;
    }
    token = (const char *)sqlite3_value_text(values[0]);
    if (token != NULL) {
        registry_enter();
        binding = binding_find_locked(token, strlen(token));
        if (binding != NULL) {
            references = binding->references;
        }
        registry_leave();
    }
    sqlite3_result_int(context, references);
}

static void sql_set_open_delay(sqlite3_context *context, int count, sqlite3_value **values) {
    const char *token;
    PxiiBinding *binding;
    int delay;
    if (count != 2) {
        sqlite3_result_error(context, "pxii_set_open_delay requires two arguments", -1);
        return;
    }
    token = (const char *)sqlite3_value_text(values[0]);
    delay = sqlite3_value_int(values[1]);
    if (token == NULL || delay < 0 || delay > 10 * 1000) {
        sqlite3_result_error(context, "invalid pxii open delay", -1);
        return;
    }
    registry_enter();
    binding = binding_find_locked(token, strlen(token));
    if (binding != NULL) {
        binding->open_delay_ms = delay;
    }
    registry_leave();
    sqlite3_result_int(context, binding != NULL);
}

static void sql_probe_memory(sqlite3_context *context, int count, sqlite3_value **values) {
    PxiiFile file;
    int out_flags = 0;
    sqlite3_int64 size = -1;
    const char expected[] = "pxii-memory";
    char observed[sizeof(expected)];
    int result;
    int operations = 0;
    (void)count;
    (void)values;
    result = pxii_open(
        &g_vfs,
        NULL,
        (sqlite3_file *)&file,
        SQLITE_OPEN_MEMORY | SQLITE_OPEN_TEMP_DB | SQLITE_OPEN_READWRITE |
            SQLITE_OPEN_DELETEONCLOSE,
        &out_flags
    );
    operations += 1;
    if (result == SQLITE_OK) {
        result = file.base.pMethods->xWrite(
            (sqlite3_file *)&file, expected, (int)sizeof(expected), 0
        );
        operations += 1;
    }
    if (result == SQLITE_OK) {
        result = file.base.pMethods->xRead(
            (sqlite3_file *)&file, observed, (int)sizeof(observed), 0
        );
        operations += 1;
    }
    if (result == SQLITE_OK) {
        result = file.base.pMethods->xFileSize((sqlite3_file *)&file, &size);
        operations += 1;
    }
    if (file.base.pMethods != NULL) {
        int close_result = file.base.pMethods->xClose((sqlite3_file *)&file);
        operations += 1;
        if (result == SQLITE_OK) {
            result = close_result;
        }
    }
    if (result != SQLITE_OK || operations != 5 ||
        size != (sqlite3_int64)sizeof(expected) ||
        memcmp(expected, observed, sizeof(expected)) != 0) {
        sqlite3_result_error(context, "pxii memory VFS probe failed", -1);
        return;
    }
    sqlite3_result_text(context, "5|0|1", -1, SQLITE_STATIC);
}

static int register_vfs(void) {
    int result;
    if (sqlite3_vfs_find("pxii") != NULL) {
        return SQLITE_OK;
    }
    g_stock_vfs = sqlite3_vfs_find(NULL);
    if (g_stock_vfs == NULL) {
        return SQLITE_ERROR;
    }
    result = initialize_temp_root();
    if (result != SQLITE_OK) {
        return result;
    }
    memset(&g_vfs, 0, sizeof(g_vfs));
    g_vfs.iVersion = 3;
    g_vfs.szOsFile = (int)sizeof(PxiiFile);
    g_vfs.mxPathname = PXII_TOKEN_MAX + 32;
    g_vfs.zName = "pxii";
    g_vfs.xOpen = pxii_open;
    g_vfs.xDelete = pxii_delete;
    g_vfs.xAccess = pxii_access;
    g_vfs.xFullPathname = pxii_full_pathname;
    g_vfs.xDlOpen = pxii_dl_open;
    g_vfs.xDlError = pxii_dl_error;
    g_vfs.xDlSym = pxii_dl_sym;
    g_vfs.xDlClose = pxii_dl_close;
    g_vfs.xRandomness = pxii_randomness;
    g_vfs.xSleep = pxii_sleep;
    g_vfs.xCurrentTime = pxii_current_time;
    g_vfs.xGetLastError = pxii_get_last_error;
    g_vfs.xCurrentTimeInt64 = pxii_current_time_int64;
    g_vfs.xSetSystemCall = pxii_set_system_call;
    g_vfs.xGetSystemCall = pxii_get_system_call;
    g_vfs.xNextSystemCall = pxii_next_system_call;
    g_registry_mutex = sqlite3_mutex_alloc(SQLITE_MUTEX_STATIC_APP1);
    if (g_registry_mutex == NULL) {
        return SQLITE_NOMEM;
    }
    return sqlite3_vfs_register(&g_vfs, 0);
}

PXII_EXPORT int sqlite3_pxiivfs_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api
) {
    int result;
    SQLITE_EXTENSION_INIT2(api);
    (void)error_message;
    result = register_vfs();
    if (result != SQLITE_OK) {
        return result;
    }
    result = sqlite3_create_function(db, "pxii_bind", 5, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, sql_bind, NULL, NULL);
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_revoke", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, sql_revoke, NULL, NULL);
    }
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_source_id", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL, sql_source_id, NULL, NULL);
    }
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_vfs_name", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL, sql_vfs_name, NULL, NULL);
    }
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_live_references", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, sql_live_references, NULL, NULL);
    }
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_set_open_delay", 2, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, sql_set_open_delay, NULL, NULL);
    }
    if (result == SQLITE_OK) {
        result = sqlite3_create_function(db, "pxii_probe_memory", 0, SQLITE_UTF8 | SQLITE_DIRECTONLY, NULL, sql_probe_memory, NULL, NULL);
    }
    return result;
}
