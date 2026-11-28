//! bunto — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and a parity test shows it behaves like the
//! TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users.
//!
//! What is answered here: what cli.ts's yargs chain answers without running
//! a command's handler, namely the help (`--help`, `-h`, `help`, for the
//! top level and for each command), `--version`/`-v`, and `.strict()`'s
//! `Unknown argument` (cli.rs), in the states of the machine where bun
//! would print the same (runtime.rs). Every handler is handed back: at
//! dec02fd each of them throws, and yargs answers that with bun's report of
//! the error (see cli.rs).

mod cli;
mod js_fallback;
mod runtime;

use std::io::Write;

use cli::Outcome;
use js_fallback::HandBack;

/// The package's JavaScript entry, relative to the package root.
const JS_ENTRY: &str = "bin/cli.js";

/// `BUNTO_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("BUNTO_NO_NATIVE").is_none()
}

/// What to print, worked out in full before anything is printed.
enum Answer {
    /// console.log of this text, exit 0.
    Out(String),
    /// yargs's failure: console.error of the help, console.error() with
    /// nothing (which bun writes to stdout, as one newline), console.error of
    /// the message; exit 1.
    Fail { help: &'static str, message: String },
}

fn answer(args: &[String]) -> Result<Answer, HandBack> {
    let outcome = cli::outcome(args).ok_or(HandBack)?;
    if outcome == Outcome::Handler {
        return Err(HandBack);
    }
    let runtime = runtime::Runtime::startup()?;
    Ok(match outcome {
        Outcome::Help(ctx) => {
            runtime.stdout_is_plain()?;
            Answer::Out(cli::help(ctx).to_string())
        }
        Outcome::Version => {
            runtime.stdout_is_plain()?;
            Answer::Out(format!("{}\n", runtime.version))
        }
        Outcome::Unknown(ctx, names) => {
            runtime.stderr_is_plain()?;
            Answer::Fail { help: cli::help(ctx), message: cli::unknown_message(&names) }
        }
        Outcome::Handler => return Err(HandBack),
    })
}

/// Prints an answer and ends the process. A reader that has gone away
/// (`| head`) is not an error, as it is not to bun.
fn finish(answer: Answer) -> ! {
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    match answer {
        Answer::Out(text) => {
            let _ = stdout.write_all(text.as_bytes()).and_then(|_| stdout.flush());
            std::process::exit(0)
        }
        Answer::Fail { help, message } => {
            let _ = stderr.write_all(help.as_bytes()).and_then(|_| stderr.flush());
            let _ = stdout.write_all(b"\n").and_then(|_| stdout.flush());
            let _ = stderr.write_all(message.as_bytes()).and_then(|_| stderr.flush());
            std::process::exit(1)
        }
    }
}

fn main() {
    // Arguments that are not valid UTF-8 are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    if let Some(args) = args.filter(|_| native()) {
        // `answer` works out the whole answer, or declines with `HandBack`
        // before it has printed or changed anything; should it panic, the
        // invocation is handed back just the same.
        if let Some(answer) = js_fallback::attempt(|| answer(&args)) {
            finish(answer);
        }
    }
    js_fallback::run(JS_ENTRY)
}
