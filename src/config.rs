use serde::Serialize;
use std::{env, str::FromStr, time::Duration};
use tracing::warn;

/// Server settings, read once at startup from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    /// Shares are deleted this many days after their last upload; 0 keeps them forever
    pub retention_days: u32,
    pub cleanup_interval: Duration,
    pub display: DisplayConfig,
}

/// What the share page shows. Passed to share.js through the page template.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayConfig {
    pub show_cost: bool,
    pub show_tokens: bool,
    pub directory: DirectoryDisplay,
    /// Initial state of the "Final answers only" toggle; a viewer's own choice takes precedence
    pub final_answers_only: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DirectoryDisplay {
    /// Hide the working directory
    None,
    /// Show only the last path segment (the project folder)
    Name,
    /// Show the full path
    Full,
}

impl FromStr for DirectoryDisplay {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "name" => Ok(Self::Name),
            "full" => Ok(Self::Full),
            _ => Err(()),
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
            port: parse_env("PORT", 3006),
            retention_days: parse_env("SHARE_RETENTION_DAYS", 30),
            cleanup_interval: Duration::from_secs(
                60 * parse_env::<u64>("SHARE_CLEANUP_INTERVAL_MINUTES", 60).max(1),
            ),
            display: DisplayConfig {
                show_cost: parse_bool_env("SHARE_SHOW_COST", false),
                show_tokens: parse_bool_env("SHARE_SHOW_TOKENS", false),
                directory: parse_env("SHARE_SHOW_DIRECTORY", DirectoryDisplay::Name),
                final_answers_only: parse_bool_env("SHARE_FINAL_ANSWERS_ONLY", true),
            },
        }
    }
}

/// Read a variable, falling back to the default (with a warning) when it is invalid.
fn parse_env<T: FromStr>(name: &str, default: T) -> T {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value.trim().parse().unwrap_or_else(|_| {
            warn!("Invalid value for {name}: {value:?}, using the default");
            default
        }),
        _ => default,
    }
}

fn parse_bool_env(name: &str, default: bool) -> bool {
    match env::var(name).map(|v| v.trim().to_ascii_lowercase()) {
        Ok(v) if ["1", "true", "yes", "on"].contains(&v.as_str()) => true,
        Ok(v) if ["0", "false", "no", "off"].contains(&v.as_str()) => false,
        Ok(v) if !v.is_empty() => {
            warn!("Invalid value for {name}: {v:?}, using the default");
            default
        }
        _ => default,
    }
}
