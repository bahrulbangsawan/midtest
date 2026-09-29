//! System-facing settings integrations: provider accounts, Midscene VLM,
//! browser discovery, and macOS privacy state.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use keyring::Entry;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::process::Command;
use tokio::time::timeout;

use crate::agents::find_agent;
use crate::commands::AppState;
use crate::settings::{self, BrowserKind};
use crate::sidecar::RuntimeOverrides;

pub const OPENROUTER_DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
const KEYCHAIN_SERVICE: &str = "com.midtest.desktop";
const KEYCHAIN_ACCOUNT: &str = "MIDSCENE_MODEL_API_KEY";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

pub const MIDSCENE_MODEL_FAMILIES: &[&str] = &[
    "doubao-vision",
    "doubao-seed",
    "gemini",
    "qwen2.5-vl",
    "qwen3-vl",
    "qwen3",
    "qwen3.5",
    "qwen3.6",
    "vlm-ui-tars",
    "vlm-ui-tars-doubao",
    "vlm-ui-tars-doubao-1.5",
    "glm-v",
    "auto-glm",
    "auto-glm-multilingual",
    "gpt-5",
    "kimi",
    "kimi3",
    "xiaomi-mimo",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidsceneConfigView {
    pub base_url: String,
    pub model_name: String,
    pub model_family: String,
    pub api_key_configured: bool,
    pub api_key_source: String,
    pub config_source: String,
    pub model_families: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidsceneConfigInput {
    pub base_url: String,
    pub model_name: String,
    pub model_family: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidsceneTestRequest {
    pub base_url: String,
    pub model_name: String,
    pub model_family: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestStage {
    pub id: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MidsceneTestResult {
    pub summary: String,
    pub model: String,
    pub stages: Vec<ConnectionTestStage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountInfo {
    pub id: String,
    pub provider: String,
    pub adapter_available: bool,
    pub adapter_path: Option<String>,
    pub cli_available: bool,
    pub authentication_status: String,
    pub account: Option<String>,
    pub environment: Vec<String>,
    pub login_command: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOption {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub executable_path: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MacosPermissionInfo {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub can_request: bool,
    pub can_open_settings: bool,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|error| format!("Direktori pengaturan aplikasi tidak tersedia: {error}"))
}

fn clean_optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn parse_env_value(raw: &str, key: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (name, value) = line.split_once('=')?;
        if name.trim() != key {
            return None;
        }
        let value = value.trim();
        let unquoted = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        clean_optional(unquoted)
    })
}

fn environment_value(root: &Path, key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .and_then(|value| clean_optional(&value))
        .or_else(|| {
            std::fs::read_to_string(root.join(".env"))
                .ok()
                .and_then(|raw| parse_env_value(&raw, key))
        })
}

fn secret_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("macOS Keychain entry could not be opened: {error}"))
}

fn stored_api_key() -> Result<Option<String>, String> {
    match secret_entry()?.get_password() {
        Ok(value) => Ok(clean_optional(&value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Midscene API key could not be read from Keychain: {error}"
        )),
    }
}

fn effective_api_key(root: &Path, supplied: Option<&str>) -> Result<Option<String>, String> {
    if let Some(value) = supplied.and_then(clean_optional) {
        return Ok(Some(value));
    }
    Ok(stored_api_key()?.or_else(|| environment_value(root, "MIDSCENE_MODEL_API_KEY")))
}

fn validate_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = Url::parse(value).map_err(|error| format!("Base URL is invalid: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Base URL must use http or https.".to_owned());
    }
    Ok(value.to_owned())
}

fn validate_model_family(value: &str) -> Result<String, String> {
    let value = value.trim();
    if MIDSCENE_MODEL_FAMILIES.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(format!(
            "MIDSCENE_MODEL_FAMILY \"{value}\" is not supported by the installed Midscene version."
        ))
    }
}

fn midscene_config_view(
    root: &Path,
    stored: &settings::Settings,
) -> Result<MidsceneConfigView, String> {
    let environment_base = environment_value(root, "MIDSCENE_MODEL_BASE_URL");
    let environment_model = environment_value(root, "MIDSCENE_MODEL_NAME");
    let environment_family = environment_value(root, "MIDSCENE_MODEL_FAMILY");
    let keychain_key = stored_api_key()?;
    let environment_key = environment_value(root, "MIDSCENE_MODEL_API_KEY");
    let saved = &stored.midscene;

    let config_source =
        if saved.base_url.is_some() || saved.model_name.is_some() || saved.model_family.is_some() {
            "settings"
        } else if environment_base.is_some()
            || environment_model.is_some()
            || environment_family.is_some()
        {
            "environment"
        } else {
            "new"
        };

    Ok(MidsceneConfigView {
        base_url: saved
            .base_url
            .clone()
            .or(environment_base)
            .unwrap_or_else(|| OPENROUTER_DEFAULT_BASE_URL.to_owned()),
        model_name: saved
            .model_name
            .clone()
            .or(environment_model)
            .unwrap_or_default(),
        model_family: saved
            .model_family
            .clone()
            .or(environment_family)
            .unwrap_or_default(),
        api_key_configured: keychain_key.is_some() || environment_key.is_some(),
        api_key_source: if keychain_key.is_some() {
            "keychain".to_owned()
        } else if environment_key.is_some() {
            "environment".to_owned()
        } else {
            "none".to_owned()
        },
        config_source: config_source.to_owned(),
        model_families: MIDSCENE_MODEL_FAMILIES
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
    })
}

pub fn runtime_overrides(
    _root: &Path,
    stored: &settings::Settings,
) -> Result<RuntimeOverrides, String> {
    let browser_path = stored
        .browser
        .executable_path
        .as_ref()
        .and_then(|value| clean_optional(value));
    Ok(RuntimeOverrides {
        model_base_url: stored.midscene.base_url.clone(),
        model_api_key: stored_api_key()?,
        model_name: stored.midscene.model_name.clone(),
        model_family: stored.midscene.model_family.clone(),
        // Do not copy `.env` values into an explicit override. Node's
        // `--env-file` remains the source of truth when settings are empty.
        browser_executable_path: browser_path,
    })
}

#[tauri::command]
pub fn get_midscene_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MidsceneConfigView, String> {
    let stored = settings::load(&config_dir(&app)?);
    midscene_config_view(state.root(), &stored)
}

#[tauri::command]
pub fn save_midscene_config(
    app: AppHandle,
    state: State<'_, AppState>,
    value: MidsceneConfigInput,
) -> Result<MidsceneConfigView, String> {
    let base_url = validate_base_url(&value.base_url)?;
    let model_name = clean_optional(&value.model_name)
        .ok_or_else(|| "MIDSCENE_MODEL_NAME is required.".to_owned())?;
    let model_family = validate_model_family(&value.model_family)?;
    let new_key = value.api_key.as_deref().and_then(clean_optional);
    let directory = config_dir(&app)?;
    let _settings_lock = state.settings_lock();
    let mut stored = settings::load(&directory);
    stored.midscene.base_url = Some(base_url);
    stored.midscene.model_name = Some(model_name);
    stored.midscene.model_family = Some(model_family);

    let previous_key = stored_api_key()?;
    if let Some(key) = new_key.as_ref() {
        secret_entry()?
            .set_password(key)
            .map_err(|error| format!("Midscene API key could not be saved to Keychain: {error}"))?;
    }

    if let Err(error) = settings::save(&directory, &stored) {
        if new_key.is_some() {
            let entry = secret_entry()?;
            if let Some(previous) = previous_key {
                let _ = entry.set_password(&previous);
            } else {
                let _ = entry.delete_credential();
            }
        }
        return Err(format!(
            "Midscene configuration could not be saved: {error}"
        ));
    }

    midscene_config_view(state.root(), &stored)
}

#[tauri::command]
pub fn clear_midscene_api_key(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MidsceneConfigView, String> {
    match secret_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(format!("Midscene API key could not be removed: {error}")),
    }
    let stored = settings::load(&config_dir(&app)?);
    midscene_config_view(state.root(), &stored)
}

fn response_excerpt(value: &str) -> String {
    const LIMIT: usize = 600;
    let mut chars = value.chars();
    let result: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        format!("{result}…")
    } else {
        result
    }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    format!("HTTP {status}: {}", response_excerpt(body.trim()))
}

async fn test_midscene_connection_body(
    request: &MidsceneTestRequest,
    api_key: &str,
) -> Result<MidsceneTestResult, String> {
    let base_url = validate_base_url(&request.base_url)?;
    let family = validate_model_family(&request.model_family)?;
    let model = clean_optional(&request.model_name)
        .ok_or_else(|| "MIDSCENE_MODEL_NAME is required.".to_owned())?;
    if api_key.trim().is_empty() {
        return Err(
            "No Midscene API key is configured. Enter one or provide it through .env.".to_owned(),
        );
    }

    let client = Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("HTTP client could not be created: {error}"))?;
    let mut stages = vec![ConnectionTestStage {
        id: "family".to_owned(),
        label: "Model family".to_owned(),
        detail: format!("{family} is recognized by Midscene 1.10.8."),
    }];

    let models_response = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| format!("Base URL could not be reached: {error}"))?;
    if matches!(
        models_response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(format!(
            "The base URL responded, but the API key was rejected (HTTP {}).",
            models_response.status()
        ));
    }
    if !models_response.status().is_success() {
        return Err(format!(
            "The model catalog request failed after reaching the base URL: {}",
            response_error(models_response).await
        ));
    }
    let models_json: Value = models_response
        .json()
        .await
        .map_err(|error| format!("The model catalog returned invalid JSON: {error}"))?;
    stages.push(ConnectionTestStage {
        id: "authentication".to_owned(),
        label: "API authentication".to_owned(),
        detail: "The provider accepted the API key and returned its model catalog.".to_owned(),
    });

    let accessible = models_json["data"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item["id"].as_str() == Some(model.as_str()))
    });
    if !accessible {
        return Err(format!(
            "The API key is valid, but model \"{model}\" was not present in the accessible model catalog."
        ));
    }
    stages.push(ConnectionTestStage {
        id: "model".to_owned(),
        label: "Model access".to_owned(),
        detail: format!("{model} is available to this API key."),
    });

    // A tiny image request exercises the multimodal OpenAI-compatible shape
    // Midscene depends on. A catalog-only check cannot prove a text-only model
    // is usable for visual grounding.
    const ONE_PIXEL_PNG: &str =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let completion_response = client
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "Inspect this test image and reply with a short JSON object containing an ok boolean." },
                    { "type": "image_url", "image_url": { "url": ONE_PIXEL_PNG } }
                ]
            }],
            "temperature": 0,
            "max_tokens": 64
        }))
        .send()
        .await
        .map_err(|error| format!("The multimodal test request could not complete: {error}"))?;
    if !completion_response.status().is_success() {
        return Err(format!(
            "The model exists, but the minimal image request failed. It may not be Midscene-compatible: {}",
            response_error(completion_response).await
        ));
    }
    let completion_json: Value = completion_response
        .json()
        .await
        .map_err(|error| format!("The completion response was not valid JSON: {error}"))?;
    let content = completion_json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The model returned no text for the minimal image request.".to_owned())?;
    stages.push(ConnectionTestStage {
        id: "multimodal".to_owned(),
        label: "Midscene-compatible request".to_owned(),
        detail: format!(
            "The model completed an image request: {}",
            response_excerpt(content)
        ),
    });

    Ok(MidsceneTestResult {
        summary: "Connection verified. The endpoint, key, model, family, and multimodal request all passed."
            .to_owned(),
        model,
        stages,
    })
}

#[tauri::command]
pub async fn test_midscene_connection(
    state: State<'_, AppState>,
    value: MidsceneTestRequest,
) -> Result<MidsceneTestResult, String> {
    let api_key = effective_api_key(state.root(), value.api_key.as_deref())?.ok_or_else(|| {
        "No Midscene API key is configured. Enter one or provide it through .env.".to_owned()
    })?;
    test_midscene_connection_body(&value, &api_key).await
}

async fn command_output(path: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    timeout(
        COMMAND_TIMEOUT,
        Command::new(path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| {
        format!(
            "{} did not answer within {} seconds",
            path.display(),
            COMMAND_TIMEOUT.as_secs()
        )
    })?
    .map_err(|error| format!("{} could not be run: {error}", path.display()))
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        directories.push(home.join(".local/bin"));
        directories.push(home.join(".cargo/bin"));
    }
    directories
        .into_iter()
        .map(|directory| directory.join(binary))
        .find(|candidate| candidate.is_file())
}

async fn agent_account(id: &str) -> ProviderAccountInfo {
    let spec = find_agent(id).expect("provider registry must contain requested account");
    let provider_label = if id == "codex" {
        "Codex / OpenAI"
    } else {
        "Claude / Anthropic"
    };
    let adapter_path = find_on_path(spec.bin);
    let (cli_name, status_args, login_command) = if id == "codex" {
        ("codex", ["login", "status"].as_slice(), "codex login")
    } else {
        ("claude", ["auth", "status"].as_slice(), "claude auth login")
    };
    let cli_path = find_on_path(cli_name);
    let mut environment = Vec::new();
    if id == "codex" {
        if std::env::var_os("CODEX_HOME").is_some() {
            environment.push("Custom CODEX_HOME is configured".to_owned());
        }
        if std::env::var_os("OPENAI_API_KEY").is_some() {
            environment.push("OPENAI_API_KEY is present in the process environment".to_owned());
        }
    } else {
        if std::env::var_os("ANTHROPIC_BASE_URL").is_some() {
            environment.push("Custom ANTHROPIC_BASE_URL is configured".to_owned());
        }
        if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
            environment.push("ANTHROPIC_API_KEY is present in the process environment".to_owned());
        }
    }

    let Some(cli_path) = cli_path else {
        return ProviderAccountInfo {
            id: id.to_owned(),
            provider: provider_label.to_owned(),
            adapter_available: adapter_path.is_some(),
            adapter_path: adapter_path.map(|path| path.display().to_string()),
            cli_available: false,
            authentication_status: "unknown".to_owned(),
            account: None,
            environment,
            login_command: Some(login_command.to_owned()),
            detail: format!(
                "The {cli_name} CLI was not found, so authentication could not be checked."
            ),
        };
    };

    match command_output(&cli_path, status_args).await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}");
            if id == "claude" {
                let parsed = serde_json::from_str::<Value>(stdout.trim()).ok();
                let logged_in = parsed
                    .as_ref()
                    .and_then(|value| value["loggedIn"].as_bool())
                    .unwrap_or(output.status.success());
                let email = parsed
                    .as_ref()
                    .and_then(|value| value["email"].as_str())
                    .map(str::to_owned);
                let organization = parsed.as_ref().and_then(|value| value["orgName"].as_str());
                ProviderAccountInfo {
                    id: id.to_owned(),
                    provider: provider_label.to_owned(),
                    adapter_available: adapter_path.is_some(),
                    adapter_path: adapter_path.map(|path| path.display().to_string()),
                    cli_available: true,
                    authentication_status: if logged_in {
                        "authenticated"
                    } else {
                        "notAuthenticated"
                    }
                    .to_owned(),
                    account: email,
                    environment,
                    login_command: Some(login_command.to_owned()),
                    detail: organization.map_or_else(
                        || "Authentication status reported by Claude CLI.".to_owned(),
                        |name| format!("Claude CLI account in {name}."),
                    ),
                }
            } else {
                let logged_in =
                    output.status.success() && combined.to_lowercase().contains("logged in");
                ProviderAccountInfo {
                    id: id.to_owned(),
                    provider: provider_label.to_owned(),
                    adapter_available: adapter_path.is_some(),
                    adapter_path: adapter_path.map(|path| path.display().to_string()),
                    cli_available: true,
                    authentication_status: if logged_in {
                        "authenticated"
                    } else {
                        "notAuthenticated"
                    }
                    .to_owned(),
                    account: logged_in.then(|| {
                        combined
                            .lines()
                            .find(|line| line.to_lowercase().contains("logged in"))
                            .unwrap_or("Codex account")
                            .trim()
                            .to_owned()
                    }),
                    environment,
                    login_command: Some(login_command.to_owned()),
                    detail: "Authentication status reported by Codex CLI.".to_owned(),
                }
            }
        }
        Err(error) => ProviderAccountInfo {
            id: id.to_owned(),
            provider: provider_label.to_owned(),
            adapter_available: adapter_path.is_some(),
            adapter_path: adapter_path.map(|path| path.display().to_string()),
            cli_available: true,
            authentication_status: "unknown".to_owned(),
            account: None,
            environment,
            login_command: Some(login_command.to_owned()),
            detail: error,
        },
    }
}

#[tauri::command]
pub async fn get_provider_accounts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ProviderAccountInfo>, String> {
    let (claude, codex) = tokio::join!(agent_account("claude"), agent_account("codex"));
    let stored = settings::load(&config_dir(&app)?);
    let midscene = midscene_config_view(state.root(), &stored)?;
    Ok(vec![
        codex,
        claude,
        ProviderAccountInfo {
            id: "midscene".to_owned(),
            provider: "Midscene VLM".to_owned(),
            adapter_available: true,
            adapter_path: None,
            cli_available: false,
            authentication_status: if midscene.api_key_configured {
                "configured"
            } else {
                "notConfigured"
            }
            .to_owned(),
            account: midscene
                .api_key_configured
                .then(|| match midscene.api_key_source.as_str() {
                    "keychain" => "API key stored in macOS Keychain".to_owned(),
                    "environment" => "API key provided by environment".to_owned(),
                    _ => "API key configured".to_owned(),
                }),
            environment: vec![format!("Configuration source: {}", midscene.config_source)],
            login_command: None,
            detail: "Midscene visual grounding uses a separate provider API key.".to_owned(),
        },
    ])
}

#[cfg(target_os = "macos")]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[tauri::command]
pub fn open_provider_login(provider: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = provider;
        return Err("Interactive provider login is currently supported on macOS only.".to_owned());
    }

    #[cfg(target_os = "macos")]
    {
        let (binary, args, label) = match provider.as_str() {
            "codex" => ("codex", "login", "Codex"),
            "claude" => ("claude", "auth login", "Claude"),
            _ => {
                return Err(format!(
                    "Provider \"{provider}\" does not use an external CLI login."
                ))
            }
        };
        let path = find_on_path(binary)
            .ok_or_else(|| format!("The {binary} CLI is not available in PATH."))?;
        let terminal_command = format!("{} {args}", shell_quote(&path.display().to_string()));
        let escaped = terminal_command.replace('\\', "\\\\").replace('"', "\\\"");
        let script =
            format!("tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell");
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|error| format!("Terminal could not be opened: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Terminal rejected the login action: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(format!("{label} login opened in Terminal."))
    }
}

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn browser_option(id: &str, label: &str, path: &str) -> BrowserOption {
    let available = executable(Path::new(path));
    BrowserOption {
        id: id.to_owned(),
        label: label.to_owned(),
        available,
        executable_path: available.then(|| path.to_owned()),
        detail: if available {
            "Detected and compatible with the Puppeteer web adapter.".to_owned()
        } else {
            "Not detected in the standard Applications location.".to_owned()
        },
    }
}

#[tauri::command]
pub fn detect_browsers() -> Vec<BrowserOption> {
    vec![
        browser_option(
            "googleChrome",
            "Google Chrome",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
        browser_option(
            "chromium",
            "Chromium",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ),
        BrowserOption {
            id: "safari".to_owned(),
            label: "Safari".to_owned(),
            available: false,
            executable_path: None,
            detail: "Unavailable: the current Midscene web adapter uses Puppeteer, which cannot control Safari/WebDriver."
                .to_owned(),
        },
    ]
}

#[tauri::command]
pub fn validate_browser_executable(path: String) -> Result<String, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("Browser executable path must be absolute.".to_owned());
    }
    if !executable(&path) {
        return Err(format!(
            "{} is not an executable browser binary.",
            path.display()
        ));
    }
    Ok(path.display().to_string())
}

pub fn selected_browser_path(stored: &settings::Settings) -> Option<String> {
    if let Some(path) = stored
        .browser
        .executable_path
        .as_ref()
        .and_then(|value| clean_optional(value))
    {
        return Some(path);
    }
    match stored.browser.kind {
        BrowserKind::GoogleChrome => detect_browsers()
            .into_iter()
            .find(|browser| browser.id == "googleChrome" && browser.available)
            .and_then(|browser| browser.executable_path),
        BrowserKind::Chromium => detect_browsers()
            .into_iter()
            .find(|browser| browser.id == "chromium" && browser.available)
            .and_then(|browser| browser.executable_path),
        BrowserKind::Custom => None,
    }
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
fn accessibility_granted() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments and is available on every
    // supported macOS version through ApplicationServices.
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(target_os = "macos")]
fn screen_recording_granted() -> bool {
    // SAFETY: this CoreGraphics preflight function has no arguments or owned
    // return value and is available since macOS 10.15.
    unsafe { CGPreflightScreenCaptureAccess() }
}

fn verified_permission(
    id: &str,
    label: &str,
    granted: bool,
    detail: &str,
    can_request: bool,
) -> MacosPermissionInfo {
    MacosPermissionInfo {
        id: id.to_owned(),
        label: label.to_owned(),
        status: if granted { "granted" } else { "notGranted" }.to_owned(),
        detail: detail.to_owned(),
        can_request,
        can_open_settings: true,
    }
}

#[tauri::command]
pub fn get_macos_permissions() -> Vec<MacosPermissionInfo> {
    #[cfg(not(target_os = "macos"))]
    {
        return [
            ("accessibility", "Accessibility"),
            ("screenRecording", "Screen Recording"),
            ("fullDiskAccess", "Full Disk Access"),
            ("automation", "Automation"),
            ("microphone", "Microphone"),
            ("camera", "Camera"),
            ("localNetwork", "Local Network"),
        ]
        .into_iter()
        .map(|(id, label)| MacosPermissionInfo {
            id: id.to_owned(),
            label: label.to_owned(),
            status: "unsupported".to_owned(),
            detail: "This permission check is available on macOS only.".to_owned(),
            can_request: false,
            can_open_settings: false,
        })
        .collect();
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            verified_permission(
                "accessibility",
                "Accessibility",
                accessibility_granted(),
                "Required for keyboard, pointer, and UI control. This state is verified for the desktop app process.",
                false,
            ),
            verified_permission(
                "screenRecording",
                "Screen Recording",
                screen_recording_granted(),
                "Required for screenshots and visual grounding. Verified through CoreGraphics preflight.",
                true,
            ),
            MacosPermissionInfo {
                id: "fullDiskAccess".to_owned(),
                label: "Full Disk Access".to_owned(),
                status: "requiresManualVerification".to_owned(),
                detail: "macOS does not provide a reliable public preflight API. Needed only when a selected workspace is privacy-protected."
                    .to_owned(),
                can_request: false,
                can_open_settings: true,
            },
            MacosPermissionInfo {
                id: "automation".to_owned(),
                label: "Automation".to_owned(),
                status: "requiresManualVerification".to_owned(),
                detail: "Automation consent is granted per target application and is prompted when an Apple Event is first sent."
                    .to_owned(),
                can_request: false,
                can_open_settings: true,
            },
            MacosPermissionInfo {
                id: "microphone".to_owned(),
                label: "Microphone".to_owned(),
                status: "notRequired".to_owned(),
                detail: "MidTest does not currently capture microphone input.".to_owned(),
                can_request: false,
                can_open_settings: true,
            },
            MacosPermissionInfo {
                id: "camera".to_owned(),
                label: "Camera".to_owned(),
                status: "notRequired".to_owned(),
                detail: "MidTest does not currently capture camera input.".to_owned(),
                can_request: false,
                can_open_settings: true,
            },
            MacosPermissionInfo {
                id: "localNetwork".to_owned(),
                label: "Local Network".to_owned(),
                status: "notRequired".to_owned(),
                detail: "The current browser and VLM flows use ordinary outbound network connections and do not browse local-network services."
                    .to_owned(),
                can_request: false,
                can_open_settings: true,
            },
        ]
    }
}

fn permission_settings_url(permission: &str) -> Option<&'static str> {
    match permission {
        "accessibility" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        "screenRecording" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        "fullDiskAccess" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        }
        "automation" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        }
        "microphone" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
        "camera" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"),
        "localNetwork" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
        }
        _ => None,
    }
}

#[tauri::command]
pub fn open_permission_settings(permission: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        return Err("System Settings privacy links are available on macOS only.".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let url = permission_settings_url(&permission)
            .ok_or_else(|| format!("Unknown macOS permission: {permission}"))?;
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| format!("System Settings could not be opened: {error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "System Settings rejected the privacy link.".to_owned())
    }
}

#[tauri::command]
pub fn request_macos_permission(permission: String) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = permission;
        return Err("Permission prompts are available on macOS only.".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        match permission.as_str() {
            "screenRecording" => {
                // SAFETY: this CoreGraphics call takes no arguments and asks
                // macOS to display its own consent UI when appropriate.
                Ok(unsafe { CGRequestScreenCaptureAccess() })
            }
            "accessibility" => {
                open_permission_settings(permission)?;
                Ok(accessibility_granted())
            }
            _ => Err(format!(
                "{permission} has no safe programmatic prompt. Open System Settings instead."
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn model_family_harus_berasal_dari_daftar_midscene() {
        assert_eq!(validate_model_family("qwen2.5-vl").unwrap(), "qwen2.5-vl");
        assert!(validate_model_family("text-only-arbitrary").is_err());
    }

    #[test]
    fn env_parser_mendukung_export_dan_kutip_tanpa_mengarang_nilai() {
        let raw = "# comment\nexport MIDSCENE_MODEL_NAME=\"vendor/model\"\nEMPTY=\n";
        assert_eq!(
            parse_env_value(raw, "MIDSCENE_MODEL_NAME"),
            Some("vendor/model".to_owned())
        );
        assert_eq!(parse_env_value(raw, "EMPTY"), None);
    }

    #[test]
    fn safari_ditandai_tidak_tersedia_dengan_alasan_adapter() {
        let safari = detect_browsers()
            .into_iter()
            .find(|browser| browser.id == "safari")
            .unwrap();
        assert!(!safari.available);
        assert!(safari.detail.contains("Puppeteer"));
    }

    #[test]
    fn path_browser_custom_harus_absolut_dan_executable() {
        assert!(validate_browser_executable("relative/browser".to_owned()).is_err());
        let path = std::env::temp_dir().join(format!("midscene-browser-{}", std::process::id()));
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&path, permissions).unwrap();
        }
        assert_eq!(
            validate_browser_executable(path.display().to_string()).unwrap(),
            path.display().to_string()
        );
        let _ = std::fs::remove_file(path);
    }

    fn fake_openai_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 8192];
                let read = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.starts_with("GET /models") {
                    r#"{"data":[{"id":"vendor/vision-model"}]}"#
                } else {
                    r#"{"choices":[{"message":{"content":"{\"ok\":true}"}}]}"#
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn connection_test_membuktikan_katalog_model_dan_request_gambar() {
        let request = MidsceneTestRequest {
            base_url: fake_openai_server(),
            model_name: "vendor/vision-model".to_owned(),
            model_family: "qwen2.5-vl".to_owned(),
            api_key: None,
        };
        let result = test_midscene_connection_body(&request, "test-key")
            .await
            .unwrap();
        assert_eq!(result.stages.len(), 4);
        assert!(result.summary.contains("verified"));
    }
}
