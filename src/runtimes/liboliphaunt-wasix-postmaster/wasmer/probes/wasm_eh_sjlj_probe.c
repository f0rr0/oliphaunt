#include <setjmp.h>
#include <stdio.h>

static jmp_buf plain_jmp;
static sigjmp_buf signal_jmp;
static volatile int stage;

static void jump_plain(void)
{
    stage = 1;
    longjmp(plain_jmp, 7);
}

static void jump_signal_zero(void)
{
    stage = 2;
    siglongjmp(signal_jmp, 0);
}

int main(void)
{
    int ret = setjmp(plain_jmp);
    if (ret == 0) {
        jump_plain();
        fprintf(stderr, "longjmp returned unexpectedly\n");
        return 10;
    }
    if (ret != 7 || stage != 1) {
        fprintf(stderr, "plain setjmp/longjmp mismatch: ret=%d stage=%d\n", ret, stage);
        return 11;
    }

    ret = sigsetjmp(signal_jmp, 1);
    if (ret == 0) {
        jump_signal_zero();
        fprintf(stderr, "siglongjmp returned unexpectedly\n");
        return 12;
    }
    if (ret != 1 || stage != 2) {
        fprintf(stderr, "signal setjmp/longjmp mismatch: ret=%d stage=%d\n", ret, stage);
        return 13;
    }

    printf("sjlj-ok plain=%d signal=%d\n", 7, ret);
    return 0;
}
