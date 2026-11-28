//! The machine as bin/cli.js would find it, for the answers cli.rs gives:
//! everything that bun, or the bundle, reads before yargs prints its help,
//! its version or a usage error, and that could change what is printed.
//! Whatever this does not imitate is `HandBack`, found before anything is
//! printed. Each rule was read off bun 1.4.0 (and checked with 1.1.45,
//! 1.2.23, 1.3.14 and 1.4.5), and each is held by a parity case `gate: …`
//! or `verify: …` (rs/parity.gen.mjs; the `verify` cases are an independent
//! verifier's, which found the long locale, simdutf's and the loaders'
//! variables, and a `bun` that does not run).

use std::io::{ErrorKind, IsTerminal};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::js_fallback::{self, HandBack};

pub struct Runtime {
    /// The package's version, as `.version(pkg.version)` prints it.
    pub version: String,
}

/// Whether anything is at `path` (a file, a directory, a dangling link). A
/// path that cannot even be looked at is a state not imitated.
fn exists(path: &Path) -> Result<bool, HandBack> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(HandBack),
    }
}

fn var(name: &str) -> Result<Option<String>, HandBack> {
    match std::env::var_os(name) {
        None => Ok(None),
        Some(value) => value.into_string().map(Some).map_err(|_| HandBack),
    }
}

/// Variables that change what bun itself does, or what the bundle does as
/// it loads: bun's own (BUN_INSTALL, which bun's installer sets for nearly
/// everyone, is only where bun lives), node's (NODE_OPTIONS, NODE_ENV, which
/// picks other `.env` files), the allocator's and ICU's, simdutf's
/// (SIMDUTF_FORCE_IMPLEMENTATION: on x64 bun 1.4.0 and 1.4.2 hang and 1.4.5
/// stops with exit 134, unless it names what the processor has), and yargs's
/// (YARGS_DISABLE_WRAP unwraps the help, YARGS_MIN_NODE_VERSION can make
/// yargs-parser throw as it loads).
///
/// Also what the system reads as it starts a program, before the program's
/// first line, where bun and this binary are not started alike: glibc's
/// ld.so reads LD_* (LD_PRELOAD of a missing library writes an error,
/// LD_DEBUG and LD_SHOW_AUXV write pages, LD_TRACE_LOADED_OBJECTS stops the
/// program) and GLIBC_TUNABLES (it warns about one it does not know), and
/// the Linux binary is static, so nothing reads them for it; macOS's dyld
/// reads DYLD_*, its libmalloc Malloc* (MallocStackLogging writes two lines
/// for every process) and its Objective-C runtime OBJC_* (OBJC_HELP writes a
/// page), each for this binary as for bun, in its own name. glibc's
/// MALLOC_* go back with them, but for two that profiles often set and that
/// were seen to change nothing: MALLOC_ARENA_MAX and macOS's MallocNanoZone.
fn changes_the_runtime(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    (name.starts_with("BUN_") && name != "BUN_INSTALL")
        || name == "GLIBC_TUNABLES"
        || (name.starts_with("MALLOC") && name != "MALLOC_ARENA_MAX" && name != "MALLOCNANOZONE")
        || ["__BUN", "NODE_", "MIMALLOC_", "ICU_", "SIMDUTF", "YARGS_", "LD_", "DYLD_", "OBJC_"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// The files bun loads into the environment from the current directory when
/// NODE_ENV is not set (it is not: see `changes_the_runtime`). A `.env` can
/// set anything above, or LANG; it is not read here.
const DOTENV_FILES: [&str; 4] = [".env", ".env.local", ".env.development", ".env.development.local"];

/// `path.resolve` of a path: absolute, with `.` and `..` taken away as text.
fn lexical(path: &Path, cwd: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in cwd.join(path).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The program bun is found as on PATH, as `js_fallback::run` starts it.
/// Whether it runs is `bun_runs`'s question.
fn bun_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| {
        // An empty entry is the current directory, for execvp.
        let dir = if dir.as_os_str().is_empty() { PathBuf::from(".") } else { dir };
        if cfg!(windows) {
            dir.join("bun.exe").is_file()
        } else {
            executable(&dir.join("bun"))
        }
    })
}

/// On Windows bun hangs, instead of failing, when TEMP names a directory it
/// cannot use (seen with bun 1.4.2); there the JavaScript is left to hang as
/// it always did. Elsewhere bun does not look at them.
fn temp_is_usable(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> bool {
    !cfg!(windows) || ["TEMP", "TMP"].iter().all(|name| var(name).is_some_and(|dir| Path::new(&dir).is_dir()))
}

#[cfg(unix)]
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable(path: &Path) -> bool {
    path.is_file()
}

/// The buns whose answers these are: the parity cases ran on 1.4.0, 1.4.2,
/// 1.4.4 and 1.4.5, and the texts were the same by hand down to 1.1.13. A
/// bun 2 may print otherwise.
const BUNS: std::ops::Range<(u64, u64, u64)> = (1, 1, 13)..(2, 0, 0);

/// How long `bun --version` may take before this is given up and the
/// JavaScript left to it. It takes milliseconds.
const BUN_TIMEOUT: Duration = Duration::from_secs(10);

/// What `bun --version` prints: `1.4.0`, or with a suffix
/// (`1.2.0-canary.1+abc`), and a line end.
fn bun_version(text: &str) -> Option<(u64, u64, u64)> {
    let line = text.strip_suffix('\n')?;
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (core, suffix) = match line.find(['-', '+']) {
        Some(at) => line.split_at(at),
        None => (line, ""),
    };
    if !suffix.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')) {
        return None;
    }
    let numbers: Vec<u64> = core
        .split('.')
        .map(|part| (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse().ok()).flatten())
        .collect::<Option<_>>()?;
    match numbers[..] {
        [major, minor, patch] => Some((major, minor, patch)),
        _ => None,
    }
}

/// Whether the bun that would run bin/cli.js runs, and is one these answers
/// are bun's for. It is asked for its version, started as `js_fallback::run`
/// starts it (`bun`, found on PATH), with nothing to read and its output
/// kept here, before anything is printed. A version manager's shim with no
/// bun behind it (`No version is set for command bun`, exit 126), a bun
/// built for another system or C library, one that writes anything else,
/// that hangs, or of another version: all go back, and bin/cli.js shows
/// what it always showed. Should `bun` be this binary under another name,
/// BUNTO_NO_NATIVE keeps it from asking again.
fn bun_runs() -> bool {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let deadline = Instant::now() + BUN_TIMEOUT;
    let spawned = Command::new("bun")
        .arg("--version")
        .env("BUNTO_NO_NATIVE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = spawned else { return false };
    // Each stream is read on a thread of its own, so that neither can fill
    // up and hold the other, nor a program bun left behind holding one hold
    // this binary.
    let (sender, receiver) = std::sync::mpsc::channel();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
        child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    ];
    for (which, pipe) in pipes.into_iter().enumerate() {
        let sender = sender.clone();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut text);
            }
            let _ = sender.send((which, text));
        });
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(1)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    };
    let mut output = [Vec::new(), Vec::new()];
    for _ in 0..2 {
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok((which, text)) => output[which] = text,
            Err(_) => return false,
        }
    }
    let [stdout, stderr] = output;
    status.success()
        && stderr.is_empty()
        && std::str::from_utf8(&stdout).ok().and_then(bun_version).is_some_and(|version| BUNS.contains(&version))
}

/// The systems where the parity cases have shown the answers to be bun's:
/// everywhere else every invocation goes back.
fn platform_is_proven() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos", windows))
}

impl Runtime {
    /// The state of the machine, if it is one the answers of cli.rs hold for.
    pub fn startup() -> Result<Runtime, HandBack> {
        if !platform_is_proven() {
            return Err(HandBack);
        }
        for (name, _) in std::env::vars_os() {
            if changes_the_runtime(&name.to_string_lossy()) {
                return Err(HandBack);
            }
        }
        // Without bun the JavaScript cannot start at all: `run` says so.
        if !bun_on_path() || !temp_is_usable(|name| std::env::var_os(name)) {
            return Err(HandBack);
        }
        // bun fails when the current directory has gone.
        let cwd = std::env::current_dir().map_err(|_| HandBack)?;
        for file in DOTENV_FILES {
            if exists(&cwd.join(file))? {
                return Err(HandBack);
            }
        }
        // bun reads bunfig.toml of the current directory (a `preload` runs
        // code before the program), and the user's own.
        let mut bunfigs = vec![cwd.join("bunfig.toml")];
        for home in ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] {
            if let Some(dir) = std::env::var_os(home).filter(|dir| !dir.is_empty()) {
                bunfigs.push(PathBuf::from(dir).join(".bunfig.toml"));
            }
        }
        for file in bunfigs {
            if exists(&file)? {
                return Err(HandBack);
            }
        }

        let root = js_fallback::package_root().ok_or(HandBack)?;
        // Without its JavaScript the package answers nothing: `run` says so.
        if !root.join(crate::JS_ENTRY).is_file() {
            return Err(HandBack);
        }
        if !loadable(root.to_str().ok_or(HandBack)?) {
            return Err(HandBack);
        }
        let version = read_version(&root.join("package.json"))?;

        // yargs's locale: the first of these that is set and not empty, cut
        // at `.` or `:`, else en_US. y18n reads `<locale>.json` (or, for
        // `de_DE`, `de.json`) from `locales` beside the package's directory
        // (`resolve(<bin/cli.js>, "../../../locales")`), and prints the keys,
        // which are the English texts, when there is no such file.
        let mut locale = "en_US".to_string();
        for name in ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] {
            if let Some(value) = var(name)?.filter(|value| !value.is_empty()) {
                locale = value;
                break;
            }
        }
        let locale = locale.split(['.', ':']).next().unwrap_or("");
        // bun may name bin/cli.js by its real path or by the one it was
        // given; neither may have `locales` beside it.
        let mut parents = vec![lexical(&root, &cwd)];
        if let Ok(real) = std::fs::canonicalize(&root) {
            parents.push(real);
        }
        for dir in parents {
            if let Some(parent) = dir.parent() {
                let locales = parent.join("locales");
                if !ordinary_locale_file(&locales, locale) || exists(&locales)? {
                    return Err(HandBack);
                }
            }
        }
        // Last, as it starts a program: the bun that would run bin/cli.js.
        if !bun_runs() {
            return Err(HandBack);
        }
        Ok(Runtime { version })
    }

    /// For text on stdout through console.log: on a terminal yargs wraps
    /// its help to the terminal's width when that is under 80 columns.
    pub fn stdout_is_plain(&self) -> Result<(), HandBack> {
        if !std::io::stdout().is_terminal() {
            return Ok(());
        }
        match terminal_columns() {
            Some(columns) if columns >= 80 => Ok(()),
            _ => Err(HandBack),
        }
    }

    /// For text on stderr through console.error: bun makes it red when
    /// stdout or stderr is a terminal, or FORCE_COLOR asks for colour.
    pub fn stderr_is_plain(&self) -> Result<(), HandBack> {
        if std::io::stdout().is_terminal() || std::io::stderr().is_terminal() || std::env::var_os("FORCE_COLOR").is_some() {
            return Err(HandBack);
        }
        Ok(())
    }
}

/// The longest path of a translation file let through, in bytes: well below
/// what any system refuses (PATH_MAX is 4096 bytes on Linux and 1024 on
/// macOS; MAX_PATH is 260 on Windows).
const LONGEST_LOCALE_FILE: usize = 240;

/// Whether y18n, opening `<locale>.json` in `locales` (a directory that is
/// not there), is told "no such file", which it takes for no translations.
/// Any other error it rethrows, and bin/cli.js ends with bun's report of it
/// instead of the help: ENAMETOOLONG past what the system takes (a LANG of
/// 5000 letters on Linux, of 1000 on macOS). So the locale has to be a plain
/// name (letters, digits, `_`, `-`, `@`; a `/` or `\` would be a path
/// elsewhere), and the whole path short. Its language's file (`de.json` for
/// `de_DE`) is shorter still. (On Windows bun 1.4.2 was told "no such file"
/// for every locale tried, 5000 letters, `*`, `<` and a space among them;
/// the one rule holds there all the same.)
fn ordinary_locale_file(locales: &Path, locale: &str) -> bool {
    let plain = locale.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'@'));
    plain && locales.as_os_str().len() + 1 + locale.len() + ".json".len() <= LONGEST_LOCALE_FILE
}

/// Whether bun can load a program from the package at `root`: it cannot
/// from a path with `?` in it, nor with `\\` outside Windows ("Module not
/// found").
fn loadable(root: &str) -> bool {
    !root.contains('?') && (cfg!(windows) || !root.contains('\\'))
}

/// `pkg.version` of the package.json that bin/cli.js was bundled with. The
/// pipeline stamps package.json before it builds bin/cli.js, and ships both,
/// so the two say the same.
fn read_version(file: &Path) -> Result<String, HandBack> {
    let text = std::fs::read(file).map_err(|_| HandBack)?;
    let json: serde_json::Value = serde_json::from_slice(&text).map_err(|_| HandBack)?;
    let version = json.get("version").and_then(serde_json::Value::as_str).ok_or(HandBack)?;
    let plain = !version.is_empty() && version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'));
    plain.then(|| version.to_string()).ok_or(HandBack)
}

/// What bun gives as `process.stdout.columns`: the terminal's width.
#[cfg(unix)]
fn terminal_columns() -> Option<u16> {
    // SAFETY: TIOCGWINSZ writes one winsize into the struct it is given.
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0;
    (ok && size.ws_col > 0).then_some(size.ws_col)
}

/// A Windows console is not imitated.
#[cfg(not(unix))]
fn terminal_columns() -> Option<u16> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_variables_go_back() {
        for name in [
            "BUN_OPTIONS", "bun_config_registry", "NODE_ENV", "NODE_OPTIONS", "MIMALLOC_VERBOSE", "ICU_DATA", "YARGS_DISABLE_WRAP", "__BUN_X",
            "SIMDUTF_FORCE_IMPLEMENTATION", "LD_PRELOAD", "LD_AUDIT", "LD_DEBUG", "LD_SHOW_AUXV", "LD_LIBRARY_PATH", "LD_TRACE_LOADED_OBJECTS",
            "GLIBC_TUNABLES", "MALLOC_CHECK_", "MALLOC_PERTURB_", "DYLD_PRINT_LIBRARIES", "DYLD_INSERT_LIBRARIES", "MallocStackLogging", "MallocScribble",
            "OBJC_HELP", "OBJC_PRINT_IMAGES",
        ] {
            assert!(changes_the_runtime(name), "{name}");
        }
        for name in [
            "BUN_INSTALL", "BUNTO_PACKAGE_ROOT", "LANG", "NO_COLOR", "PATH", "NODE", "GLIBC", "LDFLAGS", "OBJC", "JSC_useJIT", "TMPDIR", "MALLOC_ARENA_MAX",
            "MallocNanoZone",
        ] {
            assert!(!changes_the_runtime(name), "{name}");
        }
    }

    #[test]
    fn a_locale_y18n_is_told_is_not_there() {
        let locales = Path::new("/home/me/.bun/install/global/node_modules/locales");
        for locale in ["en_US", "de_DE", "C", "POSIX", "zh_Hans_CN", "sr_RS@latin", "de-DE", "", "constructor", "__proto__"] {
            assert!(ordinary_locale_file(locales, locale), "{locale:?}");
        }
        for locale in ["x/y", "a\\b", "de DE", "a*b", "a?b", "a\"b", "a<b", "a|b", "é", "\t", "a\nb"] {
            assert!(!ordinary_locale_file(locales, locale), "{locale:?}");
        }
        // The path as a whole, in bytes.
        let room = LONGEST_LOCALE_FILE - locales.as_os_str().len() - 1 - ".json".len();
        assert!(ordinary_locale_file(locales, &"a".repeat(room)));
        assert!(!ordinary_locale_file(locales, &"a".repeat(room + 1)));
        assert!(!ordinary_locale_file(locales, &"a".repeat(5000)));
        assert!(!ordinary_locale_file(&Path::new("/").join("d".repeat(240)), "en_US"));
    }

    #[test]
    fn what_bun_says_its_version_is() {
        assert_eq!(bun_version("1.4.0\n"), Some((1, 4, 0)));
        assert_eq!(bun_version("1.4.2\r\n"), Some((1, 4, 2)));
        assert_eq!(bun_version("1.2.0-canary.20250101.1+0123abc\n"), Some((1, 2, 0)));
        assert_eq!(bun_version("1.3.14+abc\n"), Some((1, 3, 14)));
        for text in ["1.4.0", "1.4\n", "1.4.0.1\n", "v1.4.0\n", " 1.4.0\n", "1.4.0 \n", "1.4.0\n\n", "1..0\n", "1.4.x\n", "1.4.0-a b\n", "\n", "", "No version is set for command bun\n", "1.4.0\nwarning\n"] {
            assert_eq!(bun_version(text), None, "{text:?}");
        }
        for version in [(1, 1, 13), (1, 1, 45), (1, 4, 0), (1, 4, 5), (1, 99, 0)] {
            assert!(BUNS.contains(&version), "{version:?}");
        }
        for version in [(1, 1, 12), (1, 0, 36), (0, 8, 1), (2, 0, 0), (3, 1, 0)] {
            assert!(!BUNS.contains(&version), "{version:?}");
        }
    }

    #[test]
    fn a_temp_directory_bun_cannot_use_goes_back_on_windows() {
        let here = std::env::temp_dir().into_os_string();
        let gone = std::env::temp_dir().join(format!("bunto-no-such-dir-{}", std::process::id())).into_os_string();
        assert!(temp_is_usable(|_| Some(here.clone())));
        assert_eq!(temp_is_usable(|_| Some(gone.clone())), !cfg!(windows));
        assert_eq!(temp_is_usable(|name| (name == "TEMP").then(|| here.clone())), !cfg!(windows));
        assert_eq!(temp_is_usable(|_| None), !cfg!(windows));
    }

    #[test]
    fn bun_cannot_load_such_a_path() {
        assert!(loadable("/home/me/.bun/install/global/node_modules/bunto"));
        assert!(!loadable("/tmp/a?b"));
        assert_eq!(loadable("/tmp/a\\b"), cfg!(windows));
    }

    #[test]
    fn paths_resolve_as_text() {
        let cwd = Path::new("/w/x");
        assert_eq!(lexical(Path::new("/a/b/../c/./d"), cwd), PathBuf::from("/a/c/d"));
        assert_eq!(lexical(Path::new("pkg/.."), cwd), PathBuf::from("/w/x"));
        assert_eq!(lexical(Path::new("../y"), cwd), PathBuf::from("/w/y"));
    }

    #[test]
    fn a_version_is_a_plain_string() {
        let dir = std::env::temp_dir().join(format!("bunto-version-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("package.json");
        let read = |text: &str| {
            std::fs::write(&file, text).unwrap();
            read_version(&file)
        };
        assert_eq!(read(r#"{"name":"bunto","version":"1.4.15"}"#), Ok("1.4.15".to_string()));
        assert_eq!(read(r#"{"version":"0.0.0-rc.1+b2"}"#), Ok("0.0.0-rc.1+b2".to_string()));
        for text in [r#"{"version":1.5}"#, r#"{"version":""}"#, r#"{"version":"1 2"}"#, r#"{"version":"x\ny"}"#, "{}", "{", "\u{feff}{\"version\":\"1\"}"] {
            assert_eq!(read(text), Err(HandBack), "{text}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
