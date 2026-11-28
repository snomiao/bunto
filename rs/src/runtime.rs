//! The machine as bin/cli.js would find it, for the answers cli.rs gives:
//! everything that bun, or the bundle, reads before yargs prints its help,
//! its version or a usage error, and that could change what is printed.
//! Whatever this does not imitate is `HandBack`, found before anything is
//! printed. Each rule was read off bun 1.4.0 (and checked with 1.1.45,
//! 1.2.23, 1.3.14 and 1.4.5), and each is held by a parity case `gate: …`
//! (rs/parity.gen.mjs).

use std::io::{ErrorKind, IsTerminal};
use std::path::{Component, Path, PathBuf};

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
/// picks other `.env` files), the allocator's and ICU's, and yargs's
/// (YARGS_DISABLE_WRAP unwraps the help, YARGS_MIN_NODE_VERSION can make
/// yargs-parser throw as it loads).
fn changes_the_runtime(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    (name.starts_with("BUN_") && name != "BUN_INSTALL")
        || name.starts_with("__BUN")
        || ["NODE_", "MIMALLOC_", "ICU_", "YARGS_"].iter().any(|prefix| name.starts_with(prefix))
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
        // which are the English texts, when there is no such file. A locale
        // that is a path is a file elsewhere.
        let mut locale = "en_US".to_string();
        for name in ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] {
            if let Some(value) = var(name)?.filter(|value| !value.is_empty()) {
                locale = value;
                break;
            }
        }
        let locale = locale.split(['.', ':']).next().unwrap_or("");
        if locale.contains(['/', '\\']) {
            return Err(HandBack);
        }
        // bun may name bin/cli.js by its real path or by the one it was
        // given; neither may have `locales` beside it.
        let mut parents = vec![lexical(&root, &cwd)];
        if let Ok(real) = std::fs::canonicalize(&root) {
            parents.push(real);
        }
        for dir in parents {
            if let Some(parent) = dir.parent() {
                if exists(&parent.join("locales"))? {
                    return Err(HandBack);
                }
            }
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
        for name in ["BUN_OPTIONS", "bun_config_registry", "NODE_ENV", "NODE_OPTIONS", "MIMALLOC_VERBOSE", "ICU_DATA", "YARGS_DISABLE_WRAP", "__BUN_X"] {
            assert!(changes_the_runtime(name), "{name}");
        }
        for name in ["BUN_INSTALL", "BUNTO_PACKAGE_ROOT", "LANG", "NO_COLOR", "PATH", "NODE"] {
            assert!(!changes_the_runtime(name), "{name}");
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
