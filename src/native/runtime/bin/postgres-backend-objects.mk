# Load PostgreSQL's own backend object graph without requesting its executable
# or frontend-tool links. Embedded builds compile timezone objects separately
# and link the server support archives explicitly. Keeping those inputs out of
# this parallel graph also prevents timezone's zic submake from racing the
# backend's support-library submake over libpgcommon.a and libpgport.a.
include Makefile

OLIPHAUNT_BACKEND_SUBDIRS = $(filter-out $(top_builddir)/src/timezone,$(SUBDIRS))
OLIPHAUNT_BACKEND_RECURSIVE_TARGETS = $(OLIPHAUNT_BACKEND_SUBDIRS:%=%-recursive)

.PHONY: oliphaunt-backend-objects
oliphaunt-backend-objects: $(OLIPHAUNT_BACKEND_RECURSIVE_TARGETS) $(LOCALOBJS)
