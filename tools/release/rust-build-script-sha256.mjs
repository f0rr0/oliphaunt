// Dependency-free SHA-256 used by generated Cargo build scripts. Keeping the
// implementation in the generated source avoids a registry lookup merely to
// validate payload bytes that are already frozen into a release carrier.
export const RUST_BUILD_SCRIPT_SHA256 = String.raw`
fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut state = [
        0x6a09e667_u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut pending = [0_u8; 64];
    let mut pending_len = 0_usize;
    let mut total_len = 0_u64;
    let mut input = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut input)?;
        if read == 0 {
            break;
        }
        total_len = total_len.wrapping_add(read as u64);
        let mut offset = 0_usize;
        if pending_len != 0 {
            let copied = (64 - pending_len).min(read);
            pending[pending_len..pending_len + copied].copy_from_slice(&input[..copied]);
            pending_len += copied;
            offset += copied;
            if pending_len == 64 {
                sha256_compress(&mut state, &pending);
                pending_len = 0;
            }
        }
        while offset + 64 <= read {
            sha256_compress(&mut state, &input[offset..offset + 64]);
            offset += 64;
        }
        if offset != read {
            pending[..read - offset].copy_from_slice(&input[offset..read]);
            pending_len = read - offset;
        }
    }

    pending[pending_len] = 0x80;
    pending_len += 1;
    if pending_len > 56 {
        pending[pending_len..].fill(0);
        sha256_compress(&mut state, &pending);
        pending.fill(0);
    } else {
        pending[pending_len..56].fill(0);
    }
    pending[56..].copy_from_slice(&total_len.wrapping_mul(8).to_be_bytes());
    sha256_compress(&mut state, &pending);

    let mut output = String::with_capacity(64);
    for word in state {
        use std::fmt::Write as _;
        write!(&mut output, "{word:08x}").expect("write SHA-256 hex digest");
    }
    Ok(output)
}

fn sha256_compress(state: &mut [u32; 8], block: &[u8]) {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut schedule = [0_u32; 64];
    for (index, bytes) in block.chunks_exact(4).take(16).enumerate() {
        schedule[index] = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    for index in 16..64 {
        let s0 = schedule[index - 15].rotate_right(7)
            ^ schedule[index - 15].rotate_right(18)
            ^ (schedule[index - 15] >> 3);
        let s1 = schedule[index - 2].rotate_right(17)
            ^ schedule[index - 2].rotate_right(19)
            ^ (schedule[index - 2] >> 10);
        schedule[index] = schedule[index - 16]
            .wrapping_add(s0)
            .wrapping_add(schedule[index - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ ((!e) & g);
        let temporary1 = h
            .wrapping_add(sum1)
            .wrapping_add(choose)
            .wrapping_add(K[index])
            .wrapping_add(schedule[index]);
        let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temporary2 = sum0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temporary1);
        d = c;
        c = b;
        b = a;
        a = temporary1.wrapping_add(temporary2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}
`;
