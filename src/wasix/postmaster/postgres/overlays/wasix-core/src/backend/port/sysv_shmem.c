/*-------------------------------------------------------------------------
 *
 * sysv_shmem.c
 *	  WASIX shared memory implementation for the PostgreSQL 18 postmaster.
 *
 * PostgreSQL 18's configure script selects src/backend/port/sysv_shmem.c for
 * every non-Windows port. WASIX does not provide SysV IPC headers, but it does
 * provide POSIX shm_open/shm_unlink and MAP_SHARED mmap. This replacement keeps
 * the PostgreSQL shmem API real and fail-closed: a leftover named object is
 * treated as in-use because the current pinned WASIX libc declares flock() but
 * does not link it, and does not expose POSIX record-lock constants. That is a
 * liveness blocker for crash/reopen, not a license to fake nattch semantics.
 *
 *-------------------------------------------------------------------------
 */
#include "postgres.h"

#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

#include "miscadmin.h"
#include "storage/dsm.h"
#include "storage/ipc.h"
#include "storage/pg_shmem.h"
#include "utils/guc.h"
#include "utils/guc_hooks.h"
#include "utils/pidfile.h"

unsigned long UsedShmemSegID = 0;
void	   *UsedShmemSegAddr = NULL;

static int	WasixShmemFd = -1;
static Size WasixShmemSize = 0;
static char WasixShmemName[96];

static void WasixFormatShmemName(char *name, size_t len,
								 unsigned long id1, unsigned long id2);
static void WasixShmemDelete(int status, Datum arg);

static void
WasixFormatShmemName(char *name, size_t len, unsigned long id1,
					 unsigned long id2)
{
	snprintf(name, len, "/postgresql-wasix-%08lx-%08lx", id1, id2);
}

static void
WasixShmemDelete(int status, Datum arg)
{
	if (UsedShmemSegAddr != NULL)
	{
		if (munmap(UsedShmemSegAddr, WasixShmemSize) < 0)
			elog(LOG, "munmap(%p, %zu) failed: %m",
				 UsedShmemSegAddr, WasixShmemSize);
		UsedShmemSegAddr = NULL;
	}

	if (WasixShmemFd >= 0)
	{
		if (close(WasixShmemFd) < 0)
			elog(LOG, "close(%d) failed: %m", WasixShmemFd);
		WasixShmemFd = -1;
	}

	if (WasixShmemName[0] != '\0')
	{
		if (shm_unlink(WasixShmemName) < 0 && errno != ENOENT)
			elog(LOG, "shm_unlink(\"%s\") failed: %m", WasixShmemName);
		WasixShmemName[0] = '\0';
	}
}

PGShmemHeader *
PGSharedMemoryCreate(Size size, PGShmemHeader **shim)
{
	struct stat statbuf;
	unsigned long id1;
	unsigned long id2;
	PGShmemHeader *hdr;
	char		line[64];

	if (stat(DataDir, &statbuf) < 0)
		ereport(FATAL,
				(errcode_for_file_access(),
				 errmsg("could not stat data directory \"%s\": %m",
						DataDir)));

	if (huge_pages == HUGE_PAGES_ON)
		ereport(ERROR,
				(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
				 errmsg("huge pages not supported on WASIX")));

	if (shared_memory_type != SHMEM_TYPE_MMAP)
		ereport(ERROR,
				(errcode(ERRCODE_FEATURE_NOT_SUPPORTED),
				 errmsg("only mmap-style shared memory is supported on WASIX")));

	Assert(size > MAXALIGN(sizeof(PGShmemHeader)));

	id1 = (unsigned long) statbuf.st_dev;
	id2 = (unsigned long) statbuf.st_ino;
	WasixFormatShmemName(WasixShmemName, sizeof(WasixShmemName), id1, id2);

	WasixShmemFd = shm_open(WasixShmemName, O_RDWR | O_CREAT | O_EXCL, 0600);
	if (WasixShmemFd < 0)
	{
		if (errno == EEXIST)
			ereport(FATAL,
					(errcode(ERRCODE_LOCK_FILE_EXISTS),
					 errmsg("pre-existing WASIX shared memory object \"%s\" is still present",
							WasixShmemName),
					 errhint("Terminate any old server processes associated with data directory \"%s\". If no such process exists, remove the stale WASIX shared memory object using the runtime's shm cleanup mechanism.",
							 DataDir)));

		ereport(FATAL,
				(errmsg("could not create WASIX shared memory object \"%s\": %m",
						WasixShmemName)));
	}

	/*
	 * From this point onward every error must close and unlink the object that
	 * this process created.  Register cleanup before either ftruncate() or
	 * mmap() can raise FATAL; the zero/NULL initial state makes partial setup
	 * safe to unwind.
	 */
	WasixShmemSize = size;
	on_shmem_exit(WasixShmemDelete, (Datum) 0);

	if (ftruncate(WasixShmemFd, size) < 0)
		ereport(FATAL,
				(errmsg("could not resize WASIX shared memory object \"%s\" to %zu bytes: %m",
						WasixShmemName, size)));

	UsedShmemSegAddr = mmap(NULL, size, PROT_READ | PROT_WRITE,
							MAP_SHARED, WasixShmemFd, 0);
	if (UsedShmemSegAddr == MAP_FAILED)
	{
		UsedShmemSegAddr = NULL;
		ereport(FATAL,
				(errmsg("could not map WASIX shared memory object \"%s\": %m",
						WasixShmemName)));
	}

	snprintf(line, sizeof(line), "%9lu %9lu", id1, id2);
	AddToDataDirLockFile(LOCK_FILE_LINE_SHMEM_KEY, line);

	hdr = (PGShmemHeader *) UsedShmemSegAddr;
	hdr->creatorPID = getpid();
	hdr->magic = PGShmemMagic;
	hdr->dsm_control = 0;
	hdr->device = statbuf.st_dev;
	hdr->inode = statbuf.st_ino;
	hdr->totalsize = size;
	hdr->freeoffset = MAXALIGN(sizeof(PGShmemHeader));

	*shim = hdr;
	UsedShmemSegID = id1;

	SetConfigOption("huge_pages_status", "off",
					PGC_INTERNAL, PGC_S_DYNAMIC_DEFAULT);

	return hdr;
}

bool
PGSharedMemoryIsInUse(unsigned long id1, unsigned long id2)
{
	char		name[sizeof(WasixShmemName)];
	int			fd;

	WasixFormatShmemName(name, sizeof(name), id1, id2);
	fd = shm_open(name, O_RDWR, 0600);
	if (fd < 0)
		return errno != ENOENT;

	close(fd);

	/*
	 * Fail closed. The pinned WASIX libc currently has no linkable file-lock
	 * primitive that would let us distinguish live attached descendants from a
	 * stale object after a hard crash.
	 */
	return true;
}

void
PGSharedMemoryDetach(void)
{
	if (UsedShmemSegAddr != NULL)
	{
		if (munmap(UsedShmemSegAddr, WasixShmemSize) < 0)
			elog(LOG, "munmap(%p, %zu) failed: %m",
				 UsedShmemSegAddr, WasixShmemSize);
		UsedShmemSegAddr = NULL;
	}

	if (WasixShmemFd >= 0)
	{
		if (close(WasixShmemFd) < 0)
			elog(LOG, "close(%d) failed: %m", WasixShmemFd);
		WasixShmemFd = -1;
	}
}

#ifdef EXEC_BACKEND
void
PGSharedMemoryReAttach(void)
{
	struct stat statbuf;
	PGShmemHeader *hdr;
	void	   *origUsedShmemSegAddr = UsedShmemSegAddr;
	unsigned long id1;
	unsigned long id2;

	Assert(UsedShmemSegAddr != NULL);
	Assert(IsUnderPostmaster);

	if (stat(DataDir, &statbuf) < 0)
		ereport(FATAL,
				(errcode_for_file_access(),
				 errmsg("could not stat data directory \"%s\": %m",
						DataDir)));

	id1 = (unsigned long) statbuf.st_dev;
	id2 = (unsigned long) statbuf.st_ino;
	WasixFormatShmemName(WasixShmemName, sizeof(WasixShmemName), id1, id2);

	WasixShmemFd = shm_open(WasixShmemName, O_RDWR, 0600);
	if (WasixShmemFd < 0)
		ereport(FATAL,
				(errmsg("could not open WASIX shared memory object \"%s\": %m",
						WasixShmemName)));

	if (fstat(WasixShmemFd, &statbuf) < 0)
		ereport(FATAL,
				(errmsg("could not stat WASIX shared memory object \"%s\": %m",
						WasixShmemName)));
	WasixShmemSize = statbuf.st_size;

	hdr = mmap(origUsedShmemSegAddr, WasixShmemSize, PROT_READ | PROT_WRITE,
			   MAP_SHARED | MAP_FIXED, WasixShmemFd, 0);
	if (hdr == MAP_FAILED)
	{
		UsedShmemSegAddr = NULL;
		ereport(FATAL,
				(errmsg("could not reattach to WASIX shared memory object \"%s\" at %p: %m",
						WasixShmemName, origUsedShmemSegAddr)));
	}
	if (hdr != origUsedShmemSegAddr)
		elog(FATAL, "reattaching to shared memory returned unexpected address (got %p, expected %p)",
			 hdr, origUsedShmemSegAddr);
	if (hdr->magic != PGShmemMagic)
		elog(FATAL, "reattaching to shared memory returned non-PostgreSQL memory");

	dsm_set_control_handle(hdr->dsm_control);
	UsedShmemSegAddr = hdr;
	UsedShmemSegID = id1;
}

void
PGSharedMemoryNoReAttach(void)
{
	Assert(UsedShmemSegAddr != NULL);
	Assert(IsUnderPostmaster);

	UsedShmemSegAddr = NULL;
	WasixShmemFd = -1;
	WasixShmemSize = 0;
	WasixShmemName[0] = '\0';
}
#endif

void
GetHugePageSize(Size *hugepagesize, int *mmap_flags)
{
	if (hugepagesize)
		*hugepagesize = 0;
	if (mmap_flags)
		*mmap_flags = 0;
}

bool
check_huge_page_size(int *newval, void **extra, GucSource source)
{
	if (*newval != 0)
	{
		GUC_check_errdetail("\"huge_page_size\" must be 0 on WASIX.");
		return false;
	}
	return true;
}
