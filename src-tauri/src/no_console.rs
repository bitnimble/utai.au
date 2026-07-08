//! Suppress the console window Windows pops up for a spawned child process.
//!
//! Without `CREATE_NO_WINDOW`, spawning a console subsystem process (the Python
//! sidecar, `uv`, `nvidia-smi`) from the GUI app flashes a `cmd`-style window on
//! Windows. No-op on every other platform.

use tokio::process::Command;

pub trait NoConsole {
    /// Apply `CREATE_NO_WINDOW` so the child runs without a console window.
    fn no_console(&mut self) -> &mut Self;
}

impl NoConsole for Command {
    #[cfg(windows)]
    fn no_console(&mut self) -> &mut Self {
        // CREATE_NO_WINDOW (winbase.h); tokio mirrors std's `creation_flags`.
        self.creation_flags(0x0800_0000)
    }

    #[cfg(not(windows))]
    fn no_console(&mut self) -> &mut Self {
        self
    }
}

impl NoConsole for std::process::Command {
    #[cfg(windows)]
    fn no_console(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }

    #[cfg(not(windows))]
    fn no_console(&mut self) -> &mut Self {
        self
    }
}
