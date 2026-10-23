import { expect, test } from 'bun:test';
import { libcSourceInventory } from './libc-metadata.mts';

const makefile = `DLMALLOC_DIR = allocator
DLMALLOC_SOURCES = $(DLMALLOC_DIR)/malloc.c
LIBC_BOTTOM_HALF_ALL_SOURCES = $(sort $(shell find bottom -name \\*.c))
LIBC_TOP_HALF_ALL_SOURCES = $(wildcard top/*.c)
ifeq ($(THREAD_MODEL), posix)
LIBC_TOP_HALF_ALL_SOURCES += top/thread.s
endif
LIBWASI_EMULATED_MMAN_SOURCES = $(filter-out %/shm_open.c,$(sort $(shell find mman -name \\*.c)))
MUSL_PRINTSCAN_SOURCES = top/printf.c
BULK_MEMORY_SOURCES = top/memcpy.c
# Add any extra flags
MUSL_OMIT_HEADERS := "alltypes.h.in"
ifeq ($(PIC), no)
MUSL_OMIT_HEADERS += dlfcn.h
endif
default:
`;
const files = [
  'allocator/malloc.c',
  'bottom/z.c',
  'bottom/a.c',
  'top/memcpy.c',
  'top/printf.c',
  'top/thread.s',
  'mman/mman.c',
  'mman/shm_open.c',
];

test('canonical POSIX/PIC membership retains assembly and excludes separate shm_open', () => {
  const inventory = libcSourceInventory(makefile, files);
  expect(inventory.bottom).toEqual(['bottom/a.c', 'bottom/z.c']);
  expect(inventory.top).toEqual(['top/memcpy.c', 'top/printf.c', 'top/thread.s']);
  expect(inventory.mman).toEqual(['mman/mman.c']);
  expect(inventory.omit).toEqual(['alltypes.h.in']);
});

test('source projection rejects missing selected sources and ambiguous membership', () => {
  expect(() =>
    libcSourceInventory(
      makefile,
      files.filter((path) => path !== 'top/thread.s'),
    ),
  ).toThrow('Missing selected libc source');
  expect(() => libcSourceInventory(makefile, [...files, files[0]])).toThrow();
  expect(() => libcSourceInventory(makefile, [...files, '../escape.c'])).toThrow();
});

test('make shell recipes and unrecognized source expansion cannot become acquisition commands', () => {
  expect(() =>
    libcSourceInventory(
      makefile.replace('find bottom -name \\*.c', 'curl https://example.test'),
      files,
    ),
  ).toThrow('Only declared source membership');
  expect(() =>
    libcSourceInventory(makefile.replace('$(wildcard top/*.c)', '$(eval arbitrary)'), files),
  ).toThrow('Unsupported source function');
});
