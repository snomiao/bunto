#!/bin/sh
# Starts the command under test for one parity case, in front of both
# implementations:
#
#   sh rs/parity/run.sh bun bin/cli.js [args…]                    the TypeScript
#   env BUNTO_PACKAGE_ROOT=<repo> sh rs/parity/run.sh <bunto> [args…]  the binary
#
# It puts rs/parity/shim first on PATH. Its `bun` writes every `bun install`,
# `bun add`, `bun remove` (and the other commands that change a project) to
# $PARITY_BUN_LOG with the directory it was asked in, and runs none of them;
# everything else goes to the real bun. So a case can show what bunto would
# have installed or removed, and no case installs anything. (On Windows a
# program that is not a shell finds bun as bun.exe, past this stand-in, see
# the end; the cases that could reach an install also point the registry at
# a closed port, see rs/parity.gen.mjs.)
#
# These variables of a case steer it, and are not passed on:
#
#   X_PKG=<dir>    use the copy of the package in <dir> (a case's setup made
#                  it): the TypeScript runs <dir>/bin/cli.js, and the binary
#                  gets BUNTO_PACKAGE_ROOT=<dir>. Under the runner's
#                  --handback check the copy takes the stand-in package's
#                  entry first, so that reaching the JavaScript still shows.
#   X_COLS=<n>     make the terminal <n> columns wide (a case with "tty").
#   X_GONE=1       start the command in a directory that has been removed.
#   X_PATH=<dir>   put <dir> first on PATH, behind the stand-in, so that a
#                  `bun` there is the one both sides start (a case's setup
#                  wrote it, and found the real bun on the PATH it has).
#   X_SET=<name>=<value>
#                  set this variable only for the command, not for the
#                  programs in front of it: on macOS the runner's sh and env
#                  are protected programs, which take every DYLD_* variable
#                  out of what they pass on, so a case's DYLD_* would never
#                  reach either side.
#   X_SIMDUTF=1    set SIMDUTF_FORCE_IMPLEMENTATION to the implementation of
#                  this machine's processor (westmere on x64, arm64 on ARM),
#                  with which bun runs; with any other value bun 1.4.0 on x64
#                  hangs before any program, a stand-in's included.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
if [ -n "${X_PATH-}" ]; then
  PATH="$X_PATH:$PATH"
fi
PARITY_REAL_BUN=$(command -v bun)
PATH="$here/shim:$PATH"
export PARITY_REAL_BUN PATH

if [ -n "${X_PKG-}" ]; then
  if [ "$1" = bun ]; then
    shift 2
    set -- bun "$X_PKG/bin/cli.js" "$@"
  fi
  if [ -n "${BUNTO_PACKAGE_ROOT-}" ]; then
    if grep -q '"stand-in"' "$BUNTO_PACKAGE_ROOT/package.json" 2> /dev/null; then
      cp "$BUNTO_PACKAGE_ROOT/bin/cli.js" "$X_PKG/bin/cli.js"
    fi
    BUNTO_PACKAGE_ROOT=$X_PKG
    export BUNTO_PACKAGE_ROOT
  fi
fi
if [ -n "${X_COLS-}" ]; then
  stty cols "$X_COLS" < /dev/tty
fi
if [ -n "${X_GONE-}" ]; then
  mkdir gone
  cd gone
  rmdir "$PWD"
fi
if [ -n "${X_SIMDUTF-}" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) SIMDUTF_FORCE_IMPLEMENTATION=westmere ;;
    *) SIMDUTF_FORCE_IMPLEMENTATION=arm64 ;;
  esac
  export SIMDUTF_FORCE_IMPLEMENTATION
fi
if [ -n "${X_SET-}" ]; then
  export "${X_SET%%=*}=${X_SET#*=}"
fi
unset X_PKG X_COLS X_GONE X_PATH X_SET X_SIMDUTF
# On Windows a program that is not a shell (the binary handing back) finds
# bun as bun.exe, past the stand-in, which is a shell script: there the
# TypeScript's bun is started directly as well, so that both sides start
# the same programs (Git Bash's sh, for one, warns about a LC_ALL it does not
# know each time it starts).
if command -v cygpath > /dev/null 2>&1; then
  if [ "$1" = bun ]; then
    shift
    set -- "$PARITY_REAL_BUN" "$@"
  fi
  # A Windows machine under load cannot always start a program: it ends
  # with STATUS_DLL_INIT_FAILED before it has run, which sh reports as 127.
  # Two such failures in one case compare the same, so the program is
  # started again instead (neither side ends with 127 by itself here).
  tries=0
  while :; do
    code=0
    "$@" || code=$?
    if [ "$code" != 127 ] || [ "$tries" -ge 8 ]; then
      exit "$code"
    fi
    tries=$((tries + 1))
    sleep 1
  done
fi
exec "$@"
