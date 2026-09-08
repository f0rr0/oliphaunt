#include <setjmp.h>
#include <signal.h>
#include <stdio.h>

static jmp_buf plain_jmp;
static sigjmp_buf signal_jmp;
static volatile int stage;
static volatile int buffer_evaluations;
static volatile int mask_evaluations;

static void jump_plain(void)
{
    stage = 1;
    longjmp(plain_jmp, 7);
}

static sigjmp_buf *signal_buffer(void)
{
    buffer_evaluations++;
    return &signal_jmp;
}

static int signal_mask_option(int save)
{
    mask_evaluations++;
    return save;
}

static int check_signal_jump(int save, int value)
{
    int observed;

#if !defined(__wasi__)
    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGUSR1);
    if (pthread_sigmask(SIG_BLOCK, &mask, NULL) != 0)
        return 20;
#endif
    buffer_evaluations = mask_evaluations = 0;

    /* Keep setjmp in the controlling expression, in this live caller frame. */
    switch (sigsetjmp(*signal_buffer(), signal_mask_option(save))) {
    case 0:
        if (buffer_evaluations != 1 || mask_evaluations != 1)
            return 21;
#if !defined(__wasi__)
        if (pthread_sigmask(SIG_UNBLOCK, &mask, NULL) != 0)
            return 22;
#endif
        siglongjmp(signal_jmp, value);
    case 1:
        observed = 1;
        break;
    case 7:
        observed = 7;
        break;
    default:
        return 23;
    }
    if (observed != (value ? value : 1) ||
        buffer_evaluations != 1 || mask_evaluations != 1)
        return 24;
#if !defined(__wasi__)
    if (pthread_sigmask(SIG_SETMASK, NULL, &mask) != 0)
        return 25;
    if (sigismember(&mask, SIGUSR1) != !!save)
        return 26;
#endif
    return 0;
}

int main(void)
{
#if !defined(__wasi__)
    sigset_t original;
#endif
    int result;

    switch (setjmp(plain_jmp)) {
    case 0:
        jump_plain();
        return 10;
    case 7:
        if (stage != 1)
            return 11;
        break;
    default:
        return 12;
    }
#if !defined(__wasi__)
    if (pthread_sigmask(SIG_SETMASK, NULL, &original) != 0)
        return 13;
#endif
    /* Reuse the buffer: savemask=0 must clear a preceding saved-mask state. */
    for (int save = 1; save >= 0; save--) {
        for (int value = 0; value <= 7; value += 7) {
            result = check_signal_jump(save, value);
            if (result != 0) {
                fprintf(stderr, "signal jump failed: save=%d value=%d check=%d\n",
                        save, value, result);
#if !defined(__wasi__)
                pthread_sigmask(SIG_SETMASK, &original, NULL);
#endif
                return result;
            }
        }
    }

#if !defined(__wasi__)
    if (pthread_sigmask(SIG_SETMASK, &original, NULL) != 0)
        return 14;
    printf("sjlj-ok plain=7 signal=1 single-evaluation mask-preserved\n");
#else
    /* The pinned WASIX pthread_sigmask succeeds without implementing masks. */
    printf("sjlj-ok plain=7 signal=1 single-evaluation signal-mask=unsupported\n");
#endif
    return 0;
}
