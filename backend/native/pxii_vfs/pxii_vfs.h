#ifndef POMODOROXII_PXII_VFS_H
#define POMODOROXII_PXII_VFS_H

#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>

/* sqlite3ext.h needs the public ABI declarations normally supplied by
 * sqlite3.h. The build deliberately ships no SQLite library or extra header:
 * the extension resolves every call through the host's sqlite3_api_routines. */
typedef int64_t sqlite3_int64;
typedef uint64_t sqlite3_uint64;
typedef sqlite3_uint64 sqlite_uint64;
typedef sqlite3_int64 sqlite_int64;
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_file sqlite3_file;
typedef struct sqlite3_io_methods sqlite3_io_methods;
typedef struct sqlite3_vfs sqlite3_vfs;
typedef struct sqlite3_context sqlite3_context;
typedef struct sqlite3_value sqlite3_value;
typedef struct sqlite3_stmt sqlite3_stmt;
typedef struct sqlite3_mutex sqlite3_mutex;
typedef struct sqlite3_blob sqlite3_blob;
typedef struct sqlite3_backup sqlite3_backup;
typedef struct sqlite3_module sqlite3_module;
typedef struct sqlite3_vtab sqlite3_vtab;
typedef struct sqlite3_index_info sqlite3_index_info;
typedef struct sqlite3_mem_methods sqlite3_mem_methods;
typedef struct sqlite3_mutex_methods sqlite3_mutex_methods;
typedef struct sqlite3_snapshot sqlite3_snapshot;
typedef struct sqlite3_str sqlite3_str;
typedef struct sqlite3_api_routines sqlite3_api_routines;
typedef struct sqlite3_pcache sqlite3_pcache;
typedef struct sqlite3_pcache_page sqlite3_pcache_page;
typedef struct sqlite3_pcache_methods2 sqlite3_pcache_methods2;
typedef struct sqlite3_rtree_geometry sqlite3_rtree_geometry;
typedef struct sqlite3_rtree_query_info sqlite3_rtree_query_info;
typedef const char *sqlite3_filename;
typedef void (*sqlite3_syscall_ptr)(void);
typedef int (*sqlite3_callback)(void *, int, char **, char **);
typedef void (*sqlite3_destructor_type)(void *);

struct sqlite3_file {
    const sqlite3_io_methods *pMethods;
};

struct sqlite3_io_methods {
    int iVersion;
    int (*xClose)(sqlite3_file *);
    int (*xRead)(sqlite3_file *, void *, int, sqlite3_int64);
    int (*xWrite)(sqlite3_file *, const void *, int, sqlite3_int64);
    int (*xTruncate)(sqlite3_file *, sqlite3_int64);
    int (*xSync)(sqlite3_file *, int);
    int (*xFileSize)(sqlite3_file *, sqlite3_int64 *);
    int (*xLock)(sqlite3_file *, int);
    int (*xUnlock)(sqlite3_file *, int);
    int (*xCheckReservedLock)(sqlite3_file *, int *);
    int (*xFileControl)(sqlite3_file *, int, void *);
    int (*xSectorSize)(sqlite3_file *);
    int (*xDeviceCharacteristics)(sqlite3_file *);
    int (*xShmMap)(sqlite3_file *, int, int, int, void volatile **);
    int (*xShmLock)(sqlite3_file *, int, int, int);
    void (*xShmBarrier)(sqlite3_file *);
    int (*xShmUnmap)(sqlite3_file *, int);
    int (*xFetch)(sqlite3_file *, sqlite3_int64, int, void **);
    int (*xUnfetch)(sqlite3_file *, sqlite3_int64, void *);
};

struct sqlite3_vfs {
    int iVersion;
    int szOsFile;
    int mxPathname;
    sqlite3_vfs *pNext;
    const char *zName;
    void *pAppData;
    int (*xOpen)(sqlite3_vfs *, sqlite3_filename, sqlite3_file *, int, int *);
    int (*xDelete)(sqlite3_vfs *, const char *, int);
    int (*xAccess)(sqlite3_vfs *, const char *, int, int *);
    int (*xFullPathname)(sqlite3_vfs *, const char *, int, char *);
    void *(*xDlOpen)(sqlite3_vfs *, const char *);
    void (*xDlError)(sqlite3_vfs *, int, char *);
    void (*(*xDlSym)(sqlite3_vfs *, void *, const char *))(void);
    void (*xDlClose)(sqlite3_vfs *, void *);
    int (*xRandomness)(sqlite3_vfs *, int, char *);
    int (*xSleep)(sqlite3_vfs *, int);
    int (*xCurrentTime)(sqlite3_vfs *, double *);
    int (*xGetLastError)(sqlite3_vfs *, int, char *);
    int (*xCurrentTimeInt64)(sqlite3_vfs *, sqlite3_int64 *);
    int (*xSetSystemCall)(sqlite3_vfs *, const char *, sqlite3_syscall_ptr);
    sqlite3_syscall_ptr (*xGetSystemCall)(sqlite3_vfs *, const char *);
    const char *(*xNextSystemCall)(sqlite3_vfs *, const char *);
};

#define SQLITE_OK 0
#define SQLITE_ERROR 1
#define SQLITE_BUSY 5
#define SQLITE_NOMEM 7
#define SQLITE_IOERR 10
#define SQLITE_CANTOPEN 14
#define SQLITE_AUTH 23
#define SQLITE_NOTFOUND 12
#define SQLITE_IOERR_READ (SQLITE_IOERR | (1 << 8))
#define SQLITE_IOERR_SHORT_READ (SQLITE_IOERR | (2 << 8))
#define SQLITE_IOERR_WRITE (SQLITE_IOERR | (3 << 8))
#define SQLITE_IOERR_FSYNC (SQLITE_IOERR | (4 << 8))
#define SQLITE_IOERR_TRUNCATE (SQLITE_IOERR | (6 << 8))
#define SQLITE_IOERR_FSTAT (SQLITE_IOERR | (7 << 8))
#define SQLITE_IOERR_UNLOCK (SQLITE_IOERR | (8 << 8))
#define SQLITE_IOERR_LOCK (SQLITE_IOERR | (15 << 8))
#define SQLITE_IOERR_DELETE (SQLITE_IOERR | (10 << 8))
#define SQLITE_IOERR_DELETE_NOENT (SQLITE_IOERR | (23 << 8))
#define SQLITE_IOERR_DIR_FSYNC (SQLITE_IOERR | (5 << 8))
#define SQLITE_IOERR_SHMOPEN (SQLITE_IOERR | (18 << 8))
#define SQLITE_IOERR_SHMSIZE (SQLITE_IOERR | (19 << 8))
#define SQLITE_IOERR_SHMLOCK (SQLITE_IOERR | (20 << 8))
#define SQLITE_IOERR_SHMMAP (SQLITE_IOERR | (21 << 8))
#define SQLITE_OPEN_READONLY 0x00000001
#define SQLITE_OPEN_READWRITE 0x00000002
#define SQLITE_OPEN_CREATE 0x00000004
#define SQLITE_OPEN_DELETEONCLOSE 0x00000008
#define SQLITE_OPEN_MEMORY 0x00000080
#define SQLITE_OPEN_MAIN_DB 0x00000100
#define SQLITE_OPEN_TEMP_DB 0x00000200
#define SQLITE_OPEN_TRANSIENT_DB 0x00000400
#define SQLITE_OPEN_MAIN_JOURNAL 0x00000800
#define SQLITE_OPEN_TEMP_JOURNAL 0x00001000
#define SQLITE_OPEN_SUBJOURNAL 0x00002000
#define SQLITE_OPEN_SUPER_JOURNAL 0x00004000
#define SQLITE_OPEN_WAL 0x00080000
#define SQLITE_LOCK_NONE 0
#define SQLITE_LOCK_SHARED 1
#define SQLITE_LOCK_RESERVED 2
#define SQLITE_LOCK_PENDING 3
#define SQLITE_LOCK_EXCLUSIVE 4
#define SQLITE_SHM_UNLOCK 1
#define SQLITE_SHM_LOCK 2
#define SQLITE_SHM_SHARED 4
#define SQLITE_SHM_EXCLUSIVE 8
#define SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN 0x00000800
#define SQLITE_FCNTL_LOCKSTATE 1
#define SQLITE_FCNTL_SIZE_HINT 5
#define SQLITE_FCNTL_SYNC 21
#define SQLITE_FCNTL_COMMIT_PHASETWO 22
#define SQLITE_FCNTL_VFSNAME 12
#define SQLITE_FCNTL_POWERSAFE_OVERWRITE 13
#define SQLITE_FCNTL_PERSIST_WAL 10
#define SQLITE_FCNTL_HAS_MOVED 20
#define SQLITE_FCNTL_LAST_ERRNO 4
#define SQLITE_MUTEX_STATIC_APP1 8
#define SQLITE_UTF8 1
#define SQLITE_DETERMINISTIC 0x000000800
#define SQLITE_DIRECTONLY 0x000080000
#define SQLITE_STATIC ((sqlite3_destructor_type)0)
#define SQLITE_TRANSIENT ((sqlite3_destructor_type)-1)

#include "sqlite3ext.h"

#if defined(_WIN32)
#define PXII_EXPORT __declspec(dllexport)
#else
#define PXII_EXPORT __attribute__((visibility("default")))
#endif

PXII_EXPORT int sqlite3_pxiivfs_init(
    sqlite3 *db,
    char **error_message,
    const sqlite3_api_routines *api
);

#endif
