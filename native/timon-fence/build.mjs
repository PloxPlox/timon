#!/usr/bin/env node
// Builds timon-fence, the Linux mission launcher (timon-fence.c), as a static
// executable with no runtime dependency.
//
//   node native/timon-fence/build.mjs [--arch host|x64|arm64|all] [--out FILE] [--optional]
//
// Output: native/timon-fence/build/linux-<arch>/timon-fence, where the daemon
// of a source checkout looks for it (orchestrator/src/host/fence.ts), or FILE
// with --out (a single architecture). The desktop package builds the host
// architecture while it prepares the daemon release: packages are built on
// their target machine, never cross-built.
//
// Compiler, first found: $TIMON_FENCE_CC (one architecture), a musl compiler
// for the target (smallest binary), then the target's gcc with a static glibc
// (needs libc.a: the libc6-dev package). --optional reports a missing
// compiler and exits 0, for a source install where the fence is a bonus.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { arch as hostArch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FENCE_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const FENCE_ARCHES = ['x64', 'arm64'];

/** Where a source checkout keeps the binary of one architecture. */
export function fenceBuildOutput(arch, dir = FENCE_SOURCE_DIR) {
  return join(dir, 'build', `linux-${arch}`, 'timon-fence');
}

const TRIPLE = { x64: 'x86_64', arm64: 'aarch64' };

/** Compilers to try for `arch`, best first; the bare names only target the host. */
export function compilerCandidates(arch, host = hostArch(), env = process.env) {
  if (env.TIMON_FENCE_CC) return [env.TIMON_FENCE_CC];
  const triple = TRIPLE[arch];
  const native = arch === host;
  return [
    `${triple}-linux-musl-gcc`,
    ...(native ? ['musl-gcc'] : []),
    ...(native ? ['cc', 'gcc'] : []),
    `${triple}-linux-gnu-gcc`,
  ];
}

export const CFLAGS = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-static', '-s',
];

/**
 * The instruction set each architecture is compiled for, named rather than
 * left to the build machine's compiler. A toolchain whose default is
 * x86-64-v3 produced a launcher that dies with SIGILL on every processor
 * without AVX2 (Celeron, Pentium, Atom, Intel before 2013), and every mission
 * on those machines then ran unfenced.
 */
export const ARCH_CFLAGS = {
  x64: ['-march=x86-64', '-mtune=generic'],
  arm64: [],
};

/**
 * `-mneeded` (GCC 11+) makes the launcher's own code declare the ISA level it
 * uses in the ELF note; without it the note only reflects the C library, and
 * a compiler defaulting to x86-64-v3 would pass the check below unseen.
 * Asked of the compiler rather than assumed, so an older one still builds.
 */
function acceptsFlag(compiler, flag) {
  try {
    execFileSync(compiler, [flag, '-x', 'c', '-c', '-o', '/dev/null', '-'], { input: 'int main(void) { return 0; }\n', stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** x86-64 levels above the baseline a shipped launcher may not require. */
const ABOVE_BASELINE = /x86-64-v[234]/;

/**
 * The "x86 ISA needed" note of an ELF file, or null when it has none.
 * `readelf` comes with binutils, which every compiler this script uses needs.
 * Its stderr is kept out of the build log: on Fedora it warns about every gap
 * in the annobin notes, which says nothing about the ISA.
 */
function isaNeededNote(binary) {
  const notes = execFileSync('readelf', ['-n', binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  return /x86 ISA needed:\s*(.+)/.exec(notes)?.[1]?.trim() ?? null;
}

/**
 * Refuses an x64 launcher that requires more than the x86-64 baseline. The
 * compiler flag alone is not proof: a static C library built for a higher
 * level by the build machine's distribution carries its own requirement into
 * the binary, and only the linked result says what it needs.
 */
export function assertBaselineIsa(binary, arch, readNote = isaNeededNote) {
  if (arch !== 'x64') return;
  const needed = readNote(binary);
  if (needed && ABOVE_BASELINE.test(needed)) {
    throw new Error(`${binary} requires ${needed}: it would crash on processors without these instructions. `
      + 'Build it with a compiler and a static C library that target the x86-64 baseline (musl-tools, or the gcc and static glibc of a distribution that targets the baseline).');
  }
}

function available(compiler) {
  try {
    execFileSync(compiler, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Compiles one architecture; returns the compiler used, or null when none is found. */
export function buildFence(arch, out = fenceBuildOutput(arch), { host = hostArch(), env = process.env, log = console.log } = {}) {
  if (!FENCE_ARCHES.includes(arch)) throw new Error(`Unsupported architecture: ${arch} (expected ${FENCE_ARCHES.join(' or ')})`);
  const compiler = compilerCandidates(arch, host, env).find(available);
  if (!compiler) return null;
  mkdirSync(dirname(out), { recursive: true });
  const needed = arch === 'x64' && acceptsFlag(compiler, '-mneeded') ? ['-mneeded'] : [];
  execFileSync(compiler, [...CFLAGS, ...ARCH_CFLAGS[arch], ...needed, '-o', out, join(FENCE_SOURCE_DIR, 'timon-fence.c')], { stdio: 'inherit' });
  chmodSync(out, 0o755);
  assertBaselineIsa(out, arch);
  // A binary for this machine must run here; another architecture is only
  // checked for presence (packages are built on their own machine anyway).
  if (arch === host) execFileSync(out, ['--version'], { stdio: 'ignore' });
  log(`[timon-fence] linux-${arch}: ${out} (${compiler}, ${statSync(out).size} bytes)`);
  return compiler;
}

function parseArgs(argv) {
  const opts = { arch: 'host', out: null, optional: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--optional') opts.optional = true;
    else if (flag === '--arch' && argv[i + 1]) opts.arch = argv[++i];
    else if (flag === '--out' && argv[i + 1]) opts.out = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (platform() !== 'linux') {
    if (opts.optional) { console.log('[timon-fence] not built: Linux only'); return; }
    throw new Error('timon-fence is a Linux launcher: build it on Linux');
  }
  const arches = opts.arch === 'all' ? FENCE_ARCHES : [opts.arch === 'host' ? hostArch() : opts.arch];
  if (opts.out && arches.length > 1) throw new Error('--out names one file: choose one --arch');
  for (const arch of arches) {
    const used = buildFence(arch, opts.out ?? fenceBuildOutput(arch));
    if (used) continue;
    const message = `[timon-fence] no C compiler for linux-${arch} (tried ${compilerCandidates(arch).join(', ')})`;
    if (opts.optional || opts.arch === 'all') console.warn(`${message}: skipped`);
    else throw new Error(`${message}. Install gcc and libc6-dev, or musl-tools.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
