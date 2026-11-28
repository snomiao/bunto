//! What the parity cases cannot show: the binary hands back when there is no
//! bun to run the JavaScript with, or one that does not run or is not of the
//! versions proven, and answers when there is one. Each run has a stand-in
//! package and an empty home of its own, and the trace on.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const TRACE_LINE: &str = "rustify: handed back to the JavaScript";

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("bunto-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["pkg/bin", "home", "cwd", "path"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        std::fs::write(dir.join("pkg/package.json"), r#"{"name":"bunto","version":"1.2.3"}"#).unwrap();
        std::fs::write(dir.join("pkg/bin/cli.js"), "console.log('stand-in');\n").unwrap();
        Scratch(dir)
    }

    fn run(&self, path: &Path, args: &[&str]) -> Output {
        self.command(path, args).output().unwrap()
    }

    fn command(&self, path: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_bunto"));
        command.args(args).current_dir(self.0.join("cwd")).env_clear();
        command.env("PATH", path).env("HOME", self.0.join("home")).env("USERPROFILE", self.0.join("home"));
        command.env("BUNTO_PACKAGE_ROOT", self.0.join("pkg")).env("RUSTIFY_HANDBACK_TRACE", "1");
        for name in ["SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
    }

    /// A `bun` in the scratch PATH: a shell script with this body.
    ///
    /// Until it has been started once, a program another test started at
    /// the same moment may still hold it open for writing (it inherited the
    /// file between fork and exec), and starting it fails with "text file
    /// busy"; the binary would take that for a bun that does not run.
    #[cfg(unix)]
    fn bun(&self, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bun = self.0.join("path/bun");
        std::fs::write(&bun, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
        for _ in 0..200 {
            match Command::new(&bun).arg("--ready").output() {
                Err(err) if err.raw_os_error() == Some(libc::ETXTBSY) => std::thread::sleep(std::time::Duration::from_millis(10)),
                _ => break,
            }
        }
        bun
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn handed_back(run: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&run.stderr);
    stderr.starts_with(TRACE_LINE) && !String::from_utf8_lossy(&run.stdout).contains("bunto <cmd>")
}

#[test]
fn without_bun_it_hands_back() {
    let scratch = Scratch::new("nobun");
    let run = scratch.run(&scratch.0.join("path"), &["--help"]);
    assert!(handed_back(&run), "{run:?}");
}

#[cfg(unix)]
#[test]
fn with_a_bun_on_path_it_answers() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("bun");
    // Only asked for its version.
    let bun = scratch.bun("echo 1.4.0");
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert_eq!(String::from_utf8_lossy(&run.stdout), "1.2.3\n");
    assert_eq!(String::from_utf8_lossy(&run.stderr), "");
    assert_eq!(run.status.code(), Some(0));
    // A bun that cannot be run is none.
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o644)).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert!(handed_back(&run), "{run:?}");
}

/// A version manager's shim with no bun behind it, a bun that is not one
/// of the versions proven, one that says anything more, or one that hangs:
/// the JavaScript is started with it, and what the user sees is what that
/// run prints, and nothing of the binary's question.
#[cfg(unix)]
#[test]
fn a_bun_that_does_not_run_or_is_another_goes_back() {
    let scratch = Scratch::new("badbun");
    for body in [
        "echo 'No version is set for command bun' >&2; exit 126",
        "echo 1.4.0; exit 1",
        "echo 1.4.0; echo 'a warning' >&2",
        "echo 1.0.36",
        "echo 1.1.12",
        "echo 2.0.0",
        "echo 'not a version'",
        "echo",
        "exit 0",
        "kill -9 $$",
    ] {
        let bun = scratch.bun(body);
        let run = scratch.run(&scratch.0.join("path"), &["--help"]);
        let alone = Command::new(&bun).arg(scratch.0.join("pkg/bin/cli.js")).arg("--help").output().unwrap();
        assert!(handed_back(&run), "{body}: {run:?}");
        assert_eq!(run.stdout, alone.stdout, "{body}");
        assert_eq!(String::from_utf8_lossy(&run.stderr), format!("{TRACE_LINE}\n{}", String::from_utf8_lossy(&alone.stderr)), "{body}");
        assert_eq!(run.status, alone.status, "{body}");
    }
}

#[cfg(unix)]
#[test]
fn a_bun_that_hangs_goes_back() {
    let scratch = Scratch::new("hangbun");
    scratch.bun("case \"$1\" in --version) exec /bin/sleep 60 ;; esac\necho ran");
    let started = std::time::Instant::now();
    let run = scratch.run(&scratch.0.join("path"), &["-v"]);
    assert!(handed_back(&run), "{run:?}");
    assert_eq!(String::from_utf8_lossy(&run.stdout), "ran\n");
    assert!(started.elapsed() < std::time::Duration::from_secs(40), "{:?}", started.elapsed());
}

#[cfg(windows)]
#[test]
fn with_a_bun_on_path_it_answers_on_windows() {
    // The bun this test runs beside, if there is one: its version is asked.
    let path = std::env::var_os("PATH").unwrap_or_default();
    let Some(dir) = std::env::split_paths(&path).find(|dir| dir.join("bun.exe").is_file()) else {
        eprintln!("no bun.exe on PATH: not tried");
        return;
    };
    let scratch = Scratch::new("bun");
    let run = scratch.run(&dir, &["--version"]);
    assert_eq!(String::from_utf8_lossy(&run.stdout), "1.2.3\n");
    assert_eq!(run.status.code(), Some(0));
}

#[cfg(windows)]
#[test]
fn a_bun_that_does_not_run_goes_back_on_windows() {
    // where.exe answers --version with an error and exit code 2.
    let scratch = Scratch::new("badbun");
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    std::fs::copy(system.join("where.exe"), scratch.0.join("path/bun.exe")).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert!(handed_back(&run), "{run:?}");
}

#[cfg(unix)]
#[test]
fn without_its_javascript_it_hands_back() {
    let scratch = Scratch::new("nojs");
    scratch.bun("echo 1.4.0");
    std::fs::remove_file(scratch.0.join("pkg/bin/cli.js")).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--help"]);
    assert!(handed_back(&run), "{run:?}");
}

#[test]
fn bunto_no_native_hands_everything_back() {
    let scratch = Scratch::new("nonative");
    let path = PathBuf::from(std::env::var_os("PATH").unwrap_or_default());
    let run = scratch.command(&path, &["--version"]).env("BUNTO_NO_NATIVE", "1").output().unwrap();
    assert!(String::from_utf8_lossy(&run.stderr).starts_with(TRACE_LINE));
    assert!(!String::from_utf8_lossy(&run.stdout).contains("1.2.3"));
}
