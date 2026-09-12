#ifndef OLIPHAUNT_POSTGIS_WINDOWS_COMPAT_H
#define OLIPHAUNT_POSTGIS_WINDOWS_COMPAT_H

#ifdef _MSC_VER
#ifndef __attribute__
#define __attribute__(x)
#endif
#ifndef __attribute
#define __attribute(x)
#endif
#ifndef FALLTHROUGH
#define FALLTHROUGH ((void)0)
#endif
#ifndef PROJ_DLL
#define PROJ_DLL
#endif
#ifndef strcasecmp
#define strcasecmp _stricmp
#endif
#ifndef strncasecmp
#define strncasecmp _strnicmp
#endif
#endif

#endif
