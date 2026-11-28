//! What the parity cases cannot show: the binary hands back when there is no
//! bun to run the JavaScript with, and answers when there is one. Each run
//! has a stand-in package and an empty home of its own, and the trace on.

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
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn without_bun_it_hands_back() {
    let scratch = Scratch::new("nobun");
    let run = scratch.run(&scratch.0.join("path"), &["--help"]);
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.starts_with(TRACE_LINE), "{stderr}");
    assert!(!String::from_utf8_lossy(&run.stdout).contains("bunto <cmd>"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn with_a_bun_on_path_it_answers() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("bun");
    let bun = scratch.0.join("path/bun");
    std::fs::write(&bun, "#!/bin/sh\necho not this bun\n").unwrap();
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert_eq!(String::from_utf8_lossy(&run.stdout), "1.2.3\n");
    assert_eq!(String::from_utf8_lossy(&run.stderr), "");
    assert_eq!(run.status.code(), Some(0));
    // A bun that cannot be run is none.
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o644)).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert!(String::from_utf8_lossy(&run.stderr).starts_with(TRACE_LINE));
}

#[cfg(any())]
#[test]
fn with_a_bun_on_path_it_answers_on_windows() {
    let scratch = Scratch::new("bun");
    // Any program will do: it is only looked for, not run.
    std::fs::copy(env!("CARGO_BIN_EXE_bunto"), scratch.0.join("path/bun.exe")).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--version"]);
    assert_eq!(String::from_utf8_lossy(&run.stdout), "1.2.3\n");
    assert_eq!(run.status.code(), Some(0));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn without_its_javascript_it_hands_back() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new("nojs");
    let bun = scratch.0.join("path/bun");
    std::fs::write(&bun, "#!/bin/sh\necho not this bun\n").unwrap();
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::remove_file(scratch.0.join("pkg/bin/cli.js")).unwrap();
    let run = scratch.run(&scratch.0.join("path"), &["--help"]);
    assert!(String::from_utf8_lossy(&run.stderr).starts_with(TRACE_LINE));
}

#[test]
fn bunto_no_native_hands_everything_back() {
    let scratch = Scratch::new("nonative");
    let path = PathBuf::from(std::env::var_os("PATH").unwrap_or_default());
    let run = scratch.command(&path, &["--version"]).env("BUNTO_NO_NATIVE", "1").output().unwrap();
    assert!(String::from_utf8_lossy(&run.stderr).starts_with(TRACE_LINE));
    assert!(!String::from_utf8_lossy(&run.stdout).contains("1.2.3"));
}
