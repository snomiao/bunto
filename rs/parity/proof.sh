#!/bin/sh
# Every proof that the binary behaves like bin/cli.js, in one go, on Linux,
# macOS or Windows (in Git Bash there):
#
#   sh rs/parity/proof.sh <rustify's templates/parity/parity.mjs> <the bunto binary>
#
# from the repository root, after `bun install --frozen-lockfile
# --ignore-scripts && bun run build` (bin/cli.js is what npm publishes and
# what the binary hands back to). The CI workflow's parity job runs this on
# each platform of `parity-platforms`, against the binary it has just built
# for that platform ($RUSTIFY_PLATFORM names it; without it, `uname` does).
# On Linux that is the static musl build (`cargo build --release --target
# x86_64-unknown-linux-musl`), which is what the pipeline ships; a glibc
# build passes as well, because the cases that set a variable of the
# loader's take the lines ld.so writes out before comparing.
#
# First rs/parity.json is checked to be what rs/parity.gen.mjs writes. Then,
# each into a log of its own:
#
#   lane<n>   rs/parity.json split into lanes (rs/parity/lanes.mjs), side by
#             side, every lane run twice: TypeScript against the binary (the
#             binary may hand back to this checkout), then the binary alone
#             against a stand-in package, which fails unless exactly the
#             cases marked "handback" for this system reach the JavaScript.
#             PARITY_LANES of them (the processors, at most 4; 3 on Windows).
#   then, side by side:
#   tty       on Linux and macOS: the whole file again with stdout and stderr
#             on a terminal (--tty stdout,stderr), TypeScript against the
#             binary
#   args      rs/parity/args.mjs: 1500 more command lines, bin/cli.js against
#             the binary
#   unit      cargo test in rs/ (it builds the crate again from the same
#             sources and Cargo.lock; it does not run the binary named above)
#
# At the end one line is printed for each that passed, and all of what a
# failed one wrote. The exit code is 0 only when all of them passed.
set -u
usage="usage: proof.sh <parity.mjs> <binary>"
# In Git Bash `pwd -W` gives a directory as Windows programs (node, the
# binary) read it.
here=$(pwd -W 2> /dev/null || pwd)
absolute() {
  case "$1" in
    /* | [A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$here" "$1" ;;
  esac
}
runner=$(absolute "${1:?$usage}")
binary=$(absolute "${2:?$usage}")
# In Git Bash, one spelling (C:/…/x) that node, the binary and the shell all
# read alike, whatever mix of slashes the workflow's variables have.
if command -v cygpath > /dev/null 2>&1; then
  runner=$(cygpath -m "$runner")
  binary=$(cygpath -m "$binary")
fi
cd "$(dirname "$0")/../.." || exit 1
root=$(pwd -W 2> /dev/null || pwd)

platform=${RUSTIFY_PLATFORM:-}
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    MINGW* | MSYS* | CYGWIN*) platform=win32 ;;
    *) platform=$(uname -s) ;;
  esac
fi
processors=$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo "${NUMBER_OF_PROCESSORS:-2}")
case "$platform" in
  win32*) most=3 others="args unit" left_out="tty" ;;
  *) most=4 others="tty args unit" left_out="" ;;
esac
lanes=${PARITY_LANES:-$((processors < most ? processors : most))}

node rs/parity.gen.mjs --check || exit 1
[ -f bin/cli.js ] || {
  echo "no bin/cli.js: run \`bun run build\` first"
  exit 1
}

# In $TMPDIR, which macOS's mktemp passes over without a template.
logs=$(mktemp -d "${TMPDIR:-/tmp}/bunto-proof.XXXXXX") || exit 1
logs_for_node=$(cygpath -m "$logs" 2> /dev/null || printf '%s' "$logs")
node rs/parity/lanes.mjs rs/parity.json "$lanes" "$logs_for_node" || exit 1

start() {
  name=$1
  shift
  (
    "$@" > "$logs/$name.log" 2>&1
    echo $? > "$logs/$name.exit"
  ) &
}
lane() {
  cases=$logs_for_node/lane-$1.json
  code=0
  node "$runner" --cases "$cases" --ts "sh rs/parity/run.sh bun bin/cli.js" --rs "env BUNTO_PACKAGE_ROOT=$root sh rs/parity/run.sh $binary" || code=1
  node "$runner" --cases "$cases" --rs "sh rs/parity/run.sh $binary" --handback BUNTO_PACKAGE_ROOT=bin/cli.js || code=1
  return $code
}
runs=""
n=0
while [ "$n" -lt "$lanes" ]; do
  start "lane$n" lane "$n"
  runs="$runs lane$n"
  n=$((n + 1))
done
wait
for name in $others; do
  case $name in
    tty) start tty node "$runner" --cases rs/parity.json --tty stdout,stderr --ts "sh rs/parity/run.sh bun bin/cli.js" --rs "env BUNTO_PACKAGE_ROOT=$root sh rs/parity/run.sh $binary" ;;
    args) start args node rs/parity/args.mjs "$binary" --jobs "$lanes" ;;
    unit) start unit cargo test --release --locked --manifest-path rs/Cargo.toml ;;
  esac
  runs="$runs $name"
done
wait

echo "proof on $platform with bun $(bun --version), $lanes lane(s):$runs"
failed=0
same=0 native=0 back=0
for name in $runs; do
  code=$(cat "$logs/$name.exit" 2> /dev/null || echo "no exit code")
  if [ "$code" != 0 ]; then
    echo "$name: FAILED ($code)"
    cat "$logs/$name.log"
    failed=1
    continue
  fi
  case $name in
    lane*)
      count=$(sed -n 's/^all \([0-9]*\) case(s) behave the same$/\1/p' "$logs/$name.log")
      same=$((same + count))
      count=$(sed -n 's/^\([0-9]*\) case(s) answered by the binary, .*/\1/p' "$logs/$name.log")
      native=$((native + count))
      count=$(sed -n 's/^.* answered by the binary, \([0-9]*\) handed back .*/\1/p' "$logs/$name.log")
      back=$((back + count))
      ;;
    unit) grep '^test result' "$logs/$name.log" | sed "s/^/$name: /" ;;
    tty) sed -n 's/^\(all [0-9]* case(s) behave the same\)$/tty: \1 with stdout and stderr on a terminal/p' "$logs/$name.log" ;;
    *) tail -n 1 "$logs/$name.log" | sed "s/^/$name: /" ;;
  esac
done
if [ "$failed" = 0 ]; then
  echo "parity: all $same case(s) behave the same; $native answered by the binary, $back handed back to the JavaScript, as the cases say"
  # Each run of each lane names the cases skipped here, and why (both runs
  # of a lane skip the same ones): the reasons, summed.
  tab=$(printf '\t')
  cat "$logs"/lane*.log | sed -n "s/^ *\([0-9][0-9]*\)  \(.*\)\$/\1$tab\2/p" | sort -t "$tab" -k 2 | awk -F "$tab" '
    $2 != reason { if (reason != "") print total "\t" reason; reason = $2; total = 0 }
    { total += $1 }
    END { if (reason != "") print total "\t" reason }' | while IFS="$tab" read -r total reason; do
    echo "  skipped on $platform: $((total / 2))  $reason"
  done
fi
for name in $left_out; do
  case $name in
    tty) echo "tty: not here (no pseudo-terminal on Windows; the cases with a terminal are skipped)" ;;
  esac
done
rm -rf "$logs"
exit $failed
