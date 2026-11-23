/*
 * libsharp-glib-shim.so: makes sharp's native binary usable inside Electron on Linux.
 * Built and wired in by patch-sharp.mjs, which explains the problem. In short: sharp's binding
 * (sharp-linux-x64.node) calls seven glib functions, and inside Electron those calls reach the
 * system's glib instead of the copy inside libvips that made the objects. patch-sharp.mjs
 * renames the binding's imports from g_<name> to q_<name>; this library provides q_<name> and
 * passes each call on to the g_<name> that is inside libvips.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

/* Use the dlopen/dlsym every glibc since 2.2.5 has (2.34 moved them and gave them a new
   version), so the library loads on older systems than the one it was built on. */
__asm__(".symver dlopen,dlopen@GLIBC_2.2.5");
__asm__(".symver dlsym,dlsym@GLIBC_2.2.5");

#ifndef VIPS_SONAME
#error "Define VIPS_SONAME as the file name of libvips, e.g. libvips-cpp.so.8.18.7"
#endif

static void *in_vips(const char *name) {
  static void *vips;
  /* libvips is already loaded (the binding needs it); this only gets a handle to it. Looking a
     name up through that handle searches libvips itself first. */
  if (!vips) vips = dlopen(VIPS_SONAME, RTLD_NOW | RTLD_NOLOAD);
  void *found = vips ? dlsym(vips, name) : NULL;
  if (!found) {
    fprintf(stderr, "sharp glib shim: %s not found in %s\n", name, VIPS_SONAME);
    abort();
  }
  return found;
}

#define FORWARD(ret, name, params, args)                       \
  ret q_##name params {                                        \
    static ret (*real) params;                                 \
    if (!real) real = (ret (*) params) in_vips("g_" #name);    \
    return real args;                                          \
  }

/* Keep in step with NAMES in patch-sharp.mjs. Pointer-sized arguments are passed through as
   they are, so the exact glib types do not matter here. */
FORWARD(void, free, (void *p), (p))
FORWARD(void *, malloc, (size_t n), (n))
FORWARD(void *, object_ref, (void *o), (o))
FORWARD(void, object_unref, (void *o), (o))
FORWARD(unsigned, log_set_handler, (const char *domain, int levels, void *handler, void *data), (domain, levels, handler, data))
FORWARD(unsigned long, signal_connect_data, (void *instance, const char *signal, void *handler, void *data, void *destroy, int flags), (instance, signal, handler, data, destroy, flags))
FORWARD(int, utf8_validate, (const char *text, long length, const char **end), (text, length, end))
