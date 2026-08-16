/*
 * mycoder-sandbox — the alpha.7 native Linux launcher (ADR-0018).
 *
 * The kernel decides *what* a subprocess may touch; this program is the only
 * thing that knows how to say that to Linux. It reads an already-validated plan,
 * applies Landlock, no_new_privs and descriptor hygiene, and execs the target.
 * It never decides policy, and it is deliberately the smallest program that can
 * hold the guarantee:
 *
 *     kernel (TypeScript)  → semantic capability profile
 *     LinuxNativeBackend   → validated LinuxSandboxPlan
 *     this launcher        → Landlock rules + nnp + fd hygiene + exec
 *
 * What it will not accept (alpha.7 §11): raw Landlock masks, namespace flags,
 * seccomp bytecode, privilege flags, or paths the kernel did not put in the
 * plan. The plan protocol is a short list of verbs and absolute paths; the
 * mapping from a verb to an access mask lives here and nowhere else, so a bug in
 * the caller cannot widen a right it does not know how to name.
 *
 * Failure is always closed. Every step that cannot be completed — an unsupported
 * ABI, an unreadable plan, a path that will not open, a rule the kernel refuses —
 * exits non-zero *before* exec. There is no path in which the target runs with
 * fewer restrictions than the plan asked for.
 *
 * Build: cc -O2 -Wall -Wextra -std=c11 -o build/mycoder-sandbox native/mycoder-sandbox.c
 * (see scripts/build-sandbox.ts, which is what the backend expects to have run).
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

/* ---- exit codes: the kernel maps these to structured errors ---------------- */

#define EXIT_USAGE 64          /* the caller invoked us wrongly */
#define EXIT_PLAN 65           /* the plan was malformed or over a limit */
#define EXIT_UNSUPPORTED 66    /* the kernel cannot provide a requested guarantee */
#define EXIT_APPLY 67          /* a restriction could not be applied */
#define EXIT_EXEC 68           /* execve itself failed */

#define MAX_RULES 256
#define MAX_LINE 4096

/* ---- Landlock ABI knowledge ------------------------------------------------
 *
 * Every right below is guarded by the ABI that introduced it. Handing a kernel a
 * bit it does not know makes `landlock_create_ruleset` fail with EINVAL, so the
 * mask is built from the *detected* ABI rather than from the headers this was
 * compiled against — those are two different kernels in the general case.
 */

#define LL_ABI_FS_BASE 1  /* read/write/exec/make/remove */
#define LL_ABI_REFER 2
#define LL_ABI_TRUNCATE 3
#define LL_ABI_NET_TCP 4
#define LL_ABI_IOCTL_DEV 5
#define LL_ABI_SCOPES 6

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_ACCESS_NET_BIND_TCP
#define LANDLOCK_ACCESS_NET_BIND_TCP (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_NET_CONNECT_TCP
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#endif

static const __u64 FS_READ =
    LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;

static const __u64 FS_WRITE = LANDLOCK_ACCESS_FS_WRITE_FILE |
                              LANDLOCK_ACCESS_FS_MAKE_REG |
                              LANDLOCK_ACCESS_FS_MAKE_DIR |
                              LANDLOCK_ACCESS_FS_MAKE_SYM |
                              LANDLOCK_ACCESS_FS_MAKE_FIFO |
                              LANDLOCK_ACCESS_FS_MAKE_SOCK |
                              LANDLOCK_ACCESS_FS_REMOVE_FILE |
                              LANDLOCK_ACCESS_FS_REMOVE_DIR;

/* Everything this launcher ever handles. Bits above the detected ABI are
 * stripped by `fs_mask_for_abi`, which is also what the probe reports. */
static __u64 fs_mask_for_abi(int abi) {
  __u64 mask = FS_READ | FS_WRITE | LANDLOCK_ACCESS_FS_EXECUTE |
               LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK;
  if (abi >= LL_ABI_REFER) mask |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= LL_ABI_TRUNCATE) mask |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= LL_ABI_IOCTL_DEV) mask |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return mask;
}

static __u64 net_mask_for_abi(int abi) {
  if (abi < LL_ABI_NET_TCP) return 0;
  return LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
}

/* ---- syscall wrappers (no libc support for these yet) ---------------------- */

static inline int ll_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size,
                                    __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static inline int ll_add_rule(int fd, enum landlock_rule_type type, const void *attr,
                              __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}

static inline int ll_restrict_self(int fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

/*
 * Narrow an access mask to what the kernel will accept for this inode type.
 *
 * Landlock refuses a rule that grants a directory-only right on a regular file
 * with EINVAL — `ro /etc/ld.so.cache` fails, not because the path is wrong, but
 * because `READ_DIR` is meaningless on it. The caller works in semantic terms
 * ("this path is readable"), so the translation belongs here, next to the other
 * mask knowledge.
 */
static __u64 mask_for_type(__u64 access, int is_dir) {
  if (is_dir) return access;
  const __u64 file_rights = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                            LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_TRUNCATE |
                            LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return access & file_rights;
}

static void die(int code, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "mycoder-sandbox: ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
  _exit(code);
}

/* ---- seccomp (§25) --------------------------------------------------------
 *
 * Defence in depth, and one specific gap: Landlock says nothing about
 * `ptrace`/`process_vm_readv`, so on a host where `kernel.yama.ptrace_scope` is
 * 0 a sandboxed process could read a sibling's memory. Relying on that sysctl
 * would make the backend's claim a property of the *host's* configuration, which
 * §13 forbids reporting as ours.
 *
 * Two deliberate choices:
 *
 *   The filter denies a *measured* list — the process-inspection and
 *   privilege/namespace families §25 names — rather than allowlisting syscalls.
 *   A full allowlist is a compatibility project (§25: "only block syscalls whose
 *   compatibility has been measured") and is explicitly not alpha.7's scope.
 *
 *   It returns EACCES, not EPERM. Yama returns EPERM, so the errno is what lets
 *   a test assert *which* mechanism refused — the same "a failure for the wrong
 *   reason is not evidence" rule alpha.6 §59 applies to egress.
 */
#define SECCOMP_DENIED_ERRNO EACCES

#if defined(__x86_64__)
#define MYCODER_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define MYCODER_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#define MYCODER_AUDIT_ARCH 0
#endif

static const int DENIED_SYSCALLS[] = {
    /* process inspection: the gap Landlock does not cover */
    __NR_ptrace,
    __NR_process_vm_readv,
    __NR_process_vm_writev,
    /* privilege and policy machinery */
    __NR_bpf,
    __NR_perf_event_open,
    __NR_keyctl,
    __NR_add_key,
    __NR_request_key,
    /* namespace and mount manipulation */
    __NR_mount,
    __NR_umount2,
    __NR_pivot_root,
    __NR_setns,
    __NR_unshare,
    /* kernel lifecycle */
    __NR_init_module,
    __NR_finit_module,
    __NR_delete_module,
    __NR_kexec_load,
    __NR_reboot,
};

static int apply_seccomp(void) {
  if (MYCODER_AUDIT_ARCH == 0) return -1;

  const size_t denied = sizeof(DENIED_SYSCALLS) / sizeof(DENIED_SYSCALLS[0]);
  /* arch check (2) + nr load (1) + one jump per denied call + errno + allow */
  struct sock_filter filter[8 + (sizeof(DENIED_SYSCALLS) / sizeof(DENIED_SYSCALLS[0])) * 1];
  size_t n = 0;

  /* A filter that ignored the architecture would be a filter that can be
   * sidestepped by entering through a different syscall table. */
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                             offsetof(struct seccomp_data, arch));
  filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, MYCODER_AUDIT_ARCH, 1, 0);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K,
                                             SECCOMP_RET_ERRNO | (SECCOMP_DENIED_ERRNO & 0xffff));
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                             offsetof(struct seccomp_data, nr));

  /* Order matters more than it looks. The *fall-through* — every comparison
   * false — must reach ALLOW, so ALLOW sits immediately after the last jeq and
   * the deny return sits after it, reached only by a taken jump. Writing it the
   * other way round produces a filter that denies every syscall including the
   * ones libc needs to exit, and the process dies before it can say why. That
   * was this file's first version, and the thing that caught it was the smoke
   * test asking "does ordinary tooling still run", not the security assertion. */
  for (size_t i = 0; i < denied; i++) {
    /* skip the remaining comparisons *and* the allow */
    __u8 to_deny = (__u8)(denied - i);
    filter[n++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                                               (__u32)DENIED_SYSCALLS[i], to_deny, 0);
  }
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  filter[n++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K,
                                             SECCOMP_RET_ERRNO | (SECCOMP_DENIED_ERRNO & 0xffff));

  struct sock_fprog prog = { .len = (unsigned short)n, .filter = filter };
  return (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0U, &prog);
}

/* ---- the plan --------------------------------------------------------------
 *
 * One verb per line, absolute paths only:
 *
 *   version 1
 *   ro   <path>     read
 *   rx   <path>     read + execute
 *   rw   <path>     read + write + create/remove beneath
 *   net  deny|unrestricted
 *   seccomp 1|0
 *   nnp  1
 *   end
 */

struct rule {
  char path[PATH_MAX];
  __u64 access;
};

struct plan {
  struct rule rules[MAX_RULES];
  int rule_count;
  int net_deny;
  int no_new_privs;
  int seccomp;
  int seen_end;
};

static void plan_add(struct plan *plan, const char *path, __u64 access) {
  if (plan->rule_count >= MAX_RULES) {
    die(EXIT_PLAN, "too many rules (limit %d)", MAX_RULES);
  }
  if (path[0] != '/') die(EXIT_PLAN, "rule path must be absolute: %s", path);
  size_t len = strlen(path);
  if (len == 0 || len >= PATH_MAX) die(EXIT_PLAN, "rule path length out of range");
  struct rule *rule = &plan->rules[plan->rule_count++];
  memcpy(rule->path, path, len + 1);
  rule->access = access;
}

static void read_plan(int fd, int abi, struct plan *plan) {
  FILE *stream = fdopen(fd, "r");
  if (!stream) die(EXIT_PLAN, "cannot read the plan: %s", strerror(errno));

  const __u64 handled = fs_mask_for_abi(abi);
  const __u64 read_access = FS_READ & handled;
  const __u64 exec_access = (FS_READ | LANDLOCK_ACCESS_FS_EXECUTE) & handled;
  const __u64 write_access = (FS_READ | FS_WRITE | LANDLOCK_ACCESS_FS_EXECUTE |
                              LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE |
                              LANDLOCK_ACCESS_FS_IOCTL_DEV) &
                             handled;

  char line[MAX_LINE];
  int version_seen = 0;

  while (fgets(line, sizeof(line), stream)) {
    size_t len = strlen(line);
    if (len > 0 && line[len - 1] == '\n') line[--len] = '\0';
    if (len == 0 || line[0] == '#') continue;

    char *space = strchr(line, ' ');
    const char *verb = line;
    const char *arg = "";
    if (space) {
      *space = '\0';
      arg = space + 1;
    }

    if (strcmp(verb, "version") == 0) {
      if (strcmp(arg, "1") != 0) die(EXIT_PLAN, "unsupported plan version: %s", arg);
      version_seen = 1;
    } else if (strcmp(verb, "ro") == 0) {
      plan_add(plan, arg, read_access);
    } else if (strcmp(verb, "rx") == 0) {
      plan_add(plan, arg, exec_access);
    } else if (strcmp(verb, "rw") == 0) {
      plan_add(plan, arg, write_access);
    } else if (strcmp(verb, "net") == 0) {
      if (strcmp(arg, "deny") == 0) {
        plan->net_deny = 1;
      } else if (strcmp(arg, "unrestricted") == 0) {
        plan->net_deny = 0;
      } else {
        die(EXIT_PLAN, "net must be deny or unrestricted, got: %s", arg);
      }
    } else if (strcmp(verb, "seccomp") == 0) {
      plan->seccomp = strcmp(arg, "1") == 0;
    } else if (strcmp(verb, "nnp") == 0) {
      plan->no_new_privs = strcmp(arg, "1") == 0;
    } else if (strcmp(verb, "end") == 0) {
      plan->seen_end = 1;
      break;
    } else {
      /* An unknown verb is a caller from a newer kernel build talking to an
       * older launcher. Refusing is the only safe reading: silently ignoring a
       * restriction we do not understand would run the workload with less than
       * the plan asked for. */
      die(EXIT_PLAN, "unknown plan verb: %s", verb);
    }
  }

  if (!version_seen) die(EXIT_PLAN, "the plan did not declare a version");
  if (!plan->seen_end) die(EXIT_PLAN, "the plan was truncated (no end marker)");
  fclose(stream);
}

/* ---- descriptor hygiene (§20, release blocker) -----------------------------
 *
 * Landlock restricts *path resolution*. A descriptor opened before the ruleset
 * was applied keeps working, so an inherited fd onto a credential file is a
 * complete bypass of every filesystem rule below. `close_range` closes the whole
 * tail in one call; the /proc walk is the fallback for a kernel without it, and
 * the blind loop is the last resort because "we could not enumerate them" must
 * not mean "we left them open".
 */
#ifndef MYCODER_NEGATIVE_CONTROL_KEEP_FDS
static void close_inherited_fds(void) {
  if (syscall(__NR_close_range, (unsigned int)3, (unsigned int)~0U, 0U) == 0) return;

  /* No `close_range`: walk a bounded range instead. A bounded loop has no
   * allocation and cannot fail halfway, and "we could not enumerate them" must
   * never be allowed to mean "we left them open". */
  struct rlimit limit;
  long ceiling = 4096;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY) {
    ceiling = (long)limit.rlim_cur;
  }
  for (long fd = 3; fd < ceiling; fd++) close((int)fd);
}
#endif

/* ---- probe (§12) -----------------------------------------------------------
 *
 * Feature support is *measured*, never inferred from the kernel version: a
 * distribution kernel can carry the syscall and have Landlock disabled at boot,
 * and the difference is invisible from `uname`.
 */
static int probe(void) {
  int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  int available = abi > 0;
  int probe_errno = available ? 0 : errno;

  printf("{\n");
  printf("  \"launcherVersion\": 1,\n");
  printf("  \"landlockAvailable\": %s,\n", available ? "true" : "false");
  printf("  \"abi\": %d,\n", available ? abi : 0);
  if (!available) {
    printf("  \"reason\": \"%s\",\n", strerror(probe_errno));
  }
  printf("  \"filesystem\": %s,\n", available ? "true" : "false");
  printf("  \"refer\": %s,\n", available && abi >= LL_ABI_REFER ? "true" : "false");
  printf("  \"truncate\": %s,\n", available && abi >= LL_ABI_TRUNCATE ? "true" : "false");
  printf("  \"networkTcp\": %s,\n", available && abi >= LL_ABI_NET_TCP ? "true" : "false");
  printf("  \"ioctlDev\": %s,\n", available && abi >= LL_ABI_IOCTL_DEV ? "true" : "false");
  printf("  \"scopes\": %s,\n", available && abi >= LL_ABI_SCOPES ? "true" : "false");
  /* Reported so the backend can say *why* a deny-all claim is partial: Landlock
   * governs TCP only, so UDP and raw sockets need a network namespace before
   * "no network" is a complete statement (§28). */
  printf("  \"networkUdp\": false,\n");
  /* An empty, harmless range: the answer being sought is whether the syscall
   * exists at all, not whether it closed anything. */
  int close_range_ok = syscall(__NR_close_range, (unsigned int)~0U, (unsigned int)~0U, 0U) == 0;
  printf("  \"closeRange\": %s\n", close_range_ok ? "true" : "false");
  printf("}\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) return probe();

  /* Usage: mycoder-sandbox --plan-fd <n> -- <argv...> */
  int plan_fd = -1;
  int arg_index = 1;
  for (; arg_index < argc; arg_index++) {
    if (strcmp(argv[arg_index], "--plan-fd") == 0 && arg_index + 1 < argc) {
      plan_fd = atoi(argv[++arg_index]);
    } else if (strcmp(argv[arg_index], "--") == 0) {
      arg_index++;
      break;
    } else {
      die(EXIT_USAGE, "unexpected argument: %s", argv[arg_index]);
    }
  }
  if (plan_fd < 3) die(EXIT_USAGE, "--plan-fd must name a descriptor >= 3");
  if (arg_index >= argc) die(EXIT_USAGE, "no command was given after --");

  int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    die(EXIT_UNSUPPORTED, "Landlock is not available on this kernel (%s)", strerror(errno));
  }

  struct plan plan;
  memset(&plan, 0, sizeof(plan));
  read_plan(plan_fd, abi, &plan); /* consumes and closes plan_fd */

  /* §20. Before any descriptor this program opens for itself, and long before
   * exec: everything inherited goes, including the one the plan arrived on.
   * Landlock restricts path *resolution*, so an fd opened earlier onto a
   * credential file would keep working and bypass every rule below.
   *
   * §21 requires the paired control — evidence that the bypass being closed is
   * real — and that control is a *different build*, never a runtime flag. A
   * switch that disabled descriptor hygiene would be reachable by anything that
   * can influence an argv, and the whole point of this step is that nothing can.
   * `tests/live/native-sandbox.test.ts` compiles this file twice. */
#ifndef MYCODER_NEGATIVE_CONTROL_KEEP_FDS
  close_inherited_fds();
#endif

  if (plan.net_deny && abi < LL_ABI_NET_TCP) {
    /* §28: a deny-all claim the kernel cannot carry is refused rather than
     * quietly reduced to "we tried". */
    die(EXIT_UNSUPPORTED, "network denial requires Landlock ABI 4; this kernel reports %d", abi);
  }

  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = fs_mask_for_abi(abi);
  if (plan.net_deny) attr.handled_access_net = net_mask_for_abi(abi);

  int ruleset_fd = ll_create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset_fd < 0) die(EXIT_APPLY, "could not create the ruleset: %s", strerror(errno));

  for (int i = 0; i < plan.rule_count; i++) {
    int path_fd = open(plan.rules[i].path, O_PATH | O_CLOEXEC);
    if (path_fd < 0) {
      /* A path in the plan that cannot be opened is a plan built against a tree
       * that has since changed. Failing here is what keeps "the rule was
       * skipped" from being indistinguishable from "the rule was applied". */
      die(EXIT_APPLY, "cannot open %s: %s", plan.rules[i].path, strerror(errno));
    }
    struct stat info;
    if (fstat(path_fd, &info) != 0) {
      die(EXIT_APPLY, "cannot stat %s: %s", plan.rules[i].path, strerror(errno));
    }

    struct landlock_path_beneath_attr beneath;
    memset(&beneath, 0, sizeof(beneath));
    beneath.parent_fd = path_fd;
    beneath.allowed_access =
        mask_for_type(plan.rules[i].access & attr.handled_access_fs, S_ISDIR(info.st_mode));
    if (beneath.allowed_access == 0) {
      die(EXIT_PLAN, "rule for %s grants nothing this inode type can carry", plan.rules[i].path);
    }
    if (ll_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &beneath, 0) != 0) {
      die(EXIT_APPLY, "cannot add a rule for %s: %s", plan.rules[i].path, strerror(errno));
    }
    close(path_fd);
  }

  if (plan.no_new_privs) {
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
      die(EXIT_APPLY, "cannot set no_new_privs: %s", strerror(errno));
    }
  } else {
    /* Landlock requires it, so the plan cannot opt out — the flag exists to be
     * explicit in the protocol, not to be optional. */
    die(EXIT_PLAN, "nnp 1 is required");
  }

  /* After no_new_privs (seccomp requires it) and before the ruleset, so that a
   * failure here still leaves nothing running. */
  if (plan.seccomp) {
    if (apply_seccomp() != 0) {
      die(EXIT_APPLY, "cannot install the seccomp filter: %s", strerror(errno));
    }
  }

  if (ll_restrict_self(ruleset_fd, 0) != 0) {
    die(EXIT_APPLY, "cannot apply the ruleset: %s", strerror(errno));
  }
  close(ruleset_fd);

  execvp(argv[arg_index], &argv[arg_index]);
  die(EXIT_EXEC, "cannot execute %s: %s", argv[arg_index], strerror(errno));
}
