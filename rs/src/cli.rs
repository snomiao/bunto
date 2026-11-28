//! What cli.ts's yargs chain does with a command line, for the command lines
//! made of plain words and flags.
//!
//! cli.ts registers three commands (`auto`, the default, also run for no
//! command at all; `remove`/`r`; `install`/`i`), `.version()`, `.help()`,
//! `.strict()`, and no `.fail()`. yargs 17.7.2 then parses a command line
//! twice: once with only the global options (`--help`/`-h`,
//! `--version`/`-v`), to find the command, and again inside the command,
//! with that command's options as well. Between the two parses an option
//! that is not known yet takes the next word as its value (`--dry auto` runs
//! the default command, which then finds `auto` left over). Inside the
//! command, help and version win; otherwise `.strict()` reports every
//! option and every word the command does not know; and only then does the
//! handler run.
//!
//! At dec02fd every handler throws (`ReferenceError: getDeps is not
//! defined`, index.tsx:50), which yargs answers with the command's help and
//! bun's report of the error: source excerpt, stack, paths. That is not
//! imitated: such a command line is `Outcome::Handler`, and goes back to the
//! JavaScript. The others are answered here.
//!
//! Only command lines whose every word is in the small vocabulary of
//! `lex` are modelled. Anything else (`--no-dry`, `--dry=true`, `-wd`,
//! `--`, `-`, numbers, capitals, `true`, an option named `constructor`) is
//! `None`, and yargs answers it.

/// Which help text, and which command's options.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ctx {
    /// The top level, before a command is chosen.
    Top,
    /// The default command, reached without naming it (`bunto`, `bunto foo`).
    /// Its help is the top-level help.
    Fallback,
    /// The default command named as `auto`.
    Auto,
    Install,
    Remove,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The help of this context on stdout, exit 0.
    Help(Ctx),
    /// The version on stdout, exit 0.
    Version,
    /// `.strict()`: the help of this context and `Unknown argument(s): …`
    /// on stderr, exit 1.
    Unknown(Ctx, Vec<String>),
    /// The command's handler runs, and throws (see the module's notes).
    Handler,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok<'a> {
    /// `--name` or `-n`, without the dashes.
    Opt(&'a str),
    Word(&'a str),
}

fn is_name(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_lowercase()) && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The words of the vocabulary: `--name` (two letters or more), `-n`, and
/// plain words, all of lower-case letters and digits, starting with a letter.
///
/// Left out on purpose: `true` and `false` (a boolean option takes them as
/// its value); `constructor` (yargs-parser looks names up in a plain object,
/// where that one is always there); a single letter after two dashes (`--h`
/// is yargs-parser's alias of `-h`).
fn lex(args: &[String]) -> Option<Vec<Tok<'_>>> {
    args.iter()
        .map(|arg| {
            let arg = arg.as_str();
            let tok = if let Some(long) = arg.strip_prefix("--") {
                (long.len() >= 2 && is_name(long)).then_some(Tok::Opt(long))?
            } else if let Some(short) = arg.strip_prefix('-') {
                (short.len() == 1 && is_name(short)).then_some(Tok::Opt(short))?
            } else {
                is_name(arg).then_some(Tok::Word(arg))?
            };
            let name = match tok {
                Tok::Opt(name) | Tok::Word(name) => name,
            };
            (!matches!(name, "true" | "false" | "constructor")).then_some(tok)
        })
        .collect()
}

/// The options (names and aliases) a context declares. All are booleans.
fn known(ctx: Ctx, name: &str) -> bool {
    let global = matches!(name, "help" | "h" | "version" | "v");
    let command = matches!(name, "watch" | "w" | "dry");
    let default_command = matches!(name, "remove" | "r" | "install" | "i");
    match ctx {
        Ctx::Top => global,
        Ctx::Fallback | Ctx::Auto => global || command || default_command,
        Ctx::Install | Ctx::Remove => global || command,
    }
}

/// yargs-parser's result, as far as it matters here.
struct Parsed<'a> {
    help: bool,
    version: bool,
    /// Options the context does not declare, in the order they first appear
    /// (yargs's `Object.keys(argv)`; none of these names looks like a number).
    unknown_options: Vec<&'a str>,
    /// `argv._`
    words: Vec<&'a str>,
}

fn parse<'a>(toks: &[Tok<'a>], ctx: Ctx) -> Parsed<'a> {
    let mut parsed = Parsed { help: false, version: false, unknown_options: Vec::new(), words: Vec::new() };
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            Tok::Word(word) => parsed.words.push(word),
            Tok::Opt(name) if known(ctx, name) => match name {
                "help" | "h" => parsed.help = true,
                "version" | "v" => parsed.version = true,
                _ => {}
            },
            Tok::Opt(name) => {
                if !parsed.unknown_options.contains(&name) {
                    parsed.unknown_options.push(name);
                }
                // An option nobody declared takes the next word as its value.
                if let Some(Tok::Word(_)) = toks.get(i + 1) {
                    i += 1;
                }
            }
        }
        i += 1;
    }
    // `help` as the last word asks for help (`.help()`'s command; `h` is not
    // one, it has a single letter).
    if parsed.words.last() == Some(&"help") {
        parsed.words.pop();
        parsed.help = true;
    }
    parsed
}

fn command(word: &str) -> Option<Ctx> {
    match word {
        "auto" => Some(Ctx::Auto),
        "install" | "i" => Some(Ctx::Install),
        "remove" | "r" => Some(Ctx::Remove),
        _ => None,
    }
}

/// What the yargs chain of cli.ts does with these arguments, or `None` when
/// they are outside the vocabulary modelled here.
pub fn outcome(args: &[String]) -> Option<Outcome> {
    let toks = lex(args)?;
    let top = parse(&toks, Ctx::Top);
    // Only the first word is looked at as a command.
    let ctx = match top.words.first().and_then(|word| command(word)) {
        Some(ctx) => ctx,
        // Help asked at the top level, with no command named: the default
        // command is not run.
        None if top.help => return Some(Outcome::Help(Ctx::Top)),
        None => Ctx::Fallback,
    };
    // Inside the command the whole command line is parsed again.
    let inner = parse(&toks, ctx);
    if inner.help {
        return Some(Outcome::Help(ctx));
    }
    if inner.version {
        return Some(Outcome::Version);
    }
    // The words the command was reached by (none for the fallback).
    let commands: Vec<&str> = match ctx {
        Ctx::Fallback => vec![],
        _ => vec![top.words[0]],
    };
    let mut unknown: Vec<String> = inner.unknown_options.iter().map(|name| name.to_string()).collect();
    // Inside a command no command is known, so every word after the ones the
    // command was reached by is unknown, …
    let rest = inner.words.get(commands.len()..).unwrap_or(&[]);
    unknown.extend(rest.iter().map(|word| word.to_string()));
    // … and yargs's second look at the words (for demanded counts) finds
    // nothing new.
    for word in rest {
        if !commands.contains(word) && !unknown.iter().any(|name| name == word) {
            unknown.push(word.to_string());
        }
    }
    if unknown.is_empty() {
        Some(Outcome::Handler)
    } else {
        Some(Outcome::Unknown(ctx, unknown))
    }
}

/// The help text of a context, as console.log prints it.
pub fn help(ctx: Ctx) -> &'static str {
    match ctx {
        Ctx::Top | Ctx::Fallback => HELP_TOP,
        Ctx::Auto => HELP_AUTO,
        Ctx::Install => HELP_INSTALL,
        Ctx::Remove => HELP_REMOVE,
    }
}

/// yargs's `Unknown argument: %s` / `Unknown arguments: %s`.
pub fn unknown_message(names: &[String]) -> String {
    let label = if names.len() == 1 { "Unknown argument" } else { "Unknown arguments" };
    format!("{label}: {}\n", names.join(", "))
}

// The help texts of yargs 17.7.2 for cli.ts at dec02fd, 80 columns wide,
// in English, each with the newline console.log adds.

/// The block every help text has (a test holds them to it).
#[cfg(test)]
const OPTIONS: &str = "Options:
  -v, --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]
      --dry                                    [boolean] [default: dry run mode]
";

const HELP_TOP: &str = concat!(
    "bunto <cmd> [args]

Commands:
  bunto auto     bun auto manage dependencies                          [default]
  bunto remove   Remove all unused dependencies                     [aliases: r]
  bunto install  Install all missing dependencies                   [aliases: i]

",
    "Options:
  -v, --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]
      --dry                                    [boolean] [default: dry run mode]
",
    "
Examples:
  bunto    auto manage all dependencies
  bunto i  install all missing dependencies
  bunto r  remove all unnessecery dependencies
"
);

const HELP_AUTO: &str = concat!("bunto auto\n\nbun auto manage dependencies\n\n", "Options:
  -v, --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]
      --dry                                    [boolean] [default: dry run mode]
");

const HELP_INSTALL: &str = concat!("bunto install\n\nInstall all missing dependencies\n\n", "Options:
  -v, --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]
      --dry                                    [boolean] [default: dry run mode]
");

const HELP_REMOVE: &str = concat!("bunto remove\n\nRemove all unused dependencies\n\n", "Options:
  -v, --version  Show version number                                   [boolean]
  -h, --help     Show help                                             [boolean]
      --dry                                    [boolean] [default: dry run mode]
");

#[cfg(test)]
mod tests {
    use super::*;

    fn of(line: &str) -> Option<Outcome> {
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        outcome(&args)
    }

    fn unknown(ctx: Ctx, names: &[&str]) -> Option<Outcome> {
        Some(Outcome::Unknown(ctx, names.iter().map(|name| name.to_string()).collect()))
    }

    #[test]
    fn the_texts_share_their_options_block() {
        for ctx in [Ctx::Top, Ctx::Auto, Ctx::Install, Ctx::Remove] {
            assert!(help(ctx).contains(OPTIONS), "{ctx:?}");
            assert!(help(ctx).ends_with('\n') && !help(ctx).ends_with("\n\n"), "{ctx:?}");
            assert!(help(ctx).lines().all(|line| line.len() <= 80 && !line.ends_with(' ')), "{ctx:?}");
        }
    }

    /// Each as bin/cli.js answered it under bun 1.4.0 (and 1.1.45 to 1.4.5).
    #[test]
    fn command_lines_as_yargs_answers_them() {
        assert_eq!(of(""), Some(Outcome::Handler));
        assert_eq!(of("-w"), Some(Outcome::Handler));
        assert_eq!(of("auto --dry -r"), Some(Outcome::Handler));
        assert_eq!(of("i --watch"), Some(Outcome::Handler));
        assert_eq!(of("r -w --dry"), Some(Outcome::Handler));
        assert_eq!(of("--help"), Some(Outcome::Help(Ctx::Top)));
        assert_eq!(of("help"), Some(Outcome::Help(Ctx::Top)));
        assert_eq!(of("help help"), Some(Outcome::Help(Ctx::Top)));
        assert_eq!(of("foo --help"), Some(Outcome::Help(Ctx::Top)));
        assert_eq!(of("--help auto"), Some(Outcome::Help(Ctx::Auto)));
        assert_eq!(of("i help"), Some(Outcome::Help(Ctx::Install)));
        assert_eq!(of("r -h"), Some(Outcome::Help(Ctx::Remove)));
        // `--dry` is not known before the command is: it takes `help` as its
        // value, and the default command then finds `help` as the last word.
        assert_eq!(of("--dry help"), Some(Outcome::Help(Ctx::Fallback)));
        assert_eq!(of("-v"), Some(Outcome::Version));
        assert_eq!(of("-v foo"), Some(Outcome::Version));
        assert_eq!(of("i --version"), Some(Outcome::Version));
        assert_eq!(of("--version --help"), Some(Outcome::Help(Ctx::Top)));
        assert_eq!(of("foo"), unknown(Ctx::Fallback, &["foo"]));
        assert_eq!(of("-x foo"), unknown(Ctx::Fallback, &["x"]));
        assert_eq!(of("foo --nope"), unknown(Ctx::Fallback, &["nope", "foo"]));
        assert_eq!(of("--dry auto"), unknown(Ctx::Fallback, &["auto"]));
        assert_eq!(of("foo i"), unknown(Ctx::Fallback, &["foo", "i"]));
        assert_eq!(of("help foo"), unknown(Ctx::Fallback, &["help", "foo"]));
        assert_eq!(of("auto auto"), unknown(Ctx::Auto, &["auto"]));
        assert_eq!(of("i -r"), unknown(Ctx::Install, &["r"]));
        assert_eq!(of("--install i r"), unknown(Ctx::Remove, &["install"]));
        assert_eq!(of("bar --bar"), unknown(Ctx::Fallback, &["bar", "bar"]));
    }

    #[test]
    fn leaves_everything_else_to_yargs() {
        for line in [
            "--no-dry", "--dry=true", "-wd", "-hv", "--", "-", "--h", "--HELP", "Help", "1", "0x10", "--dry true", "--nope false",
            "--constructor", "constructor", "-W", "--a-b", "--a_b", "a.b", "@x", "é",
        ] {
            assert_eq!(of(line), None, "{line:?}");
        }
        assert_eq!(outcome(&[String::new()]), None);
        assert_eq!(outcome(&["two words".to_string()]), None);
    }

    #[test]
    fn the_message_counts_its_names() {
        assert_eq!(unknown_message(&["x".to_string()]), "Unknown argument: x\n");
        assert_eq!(unknown_message(&["a".to_string(), "b".to_string()]), "Unknown arguments: a, b\n");
    }
}
