//! Klien ACP: menjalankan biner adapter, bicara JSON-RPC lewat stdio, dan
//! menyelesaikan handshake `initialize`.
//!
//! Bentuk API crate `agent-client-protocol` 2.0.0 yang menentukan desain modul ini:
//!
//! * Transport untuk *memanggil* proses anak adalah [`AcpAgent`], bukan `Stdio`.
//!   `Stdio` memakai stdin/stdout **milik proses kita sendiri**, jadi itu untuk
//!   sisi agen yang di-spawn orang lain, bukan untuk sisi klien yang men-spawn.
//! * Koneksi hanya hidup selama closure `Builder::connect_with` berjalan. Untuk
//!   menyimpan koneksi hidup di dalam [`AcpHandle`], future koneksi dijalankan di
//!   task tokio dan closure-nya menunggu sinyal shutdown.
//! * `AcpAgent` memasang `ChildGuard` yang mengirim SIGKILL ke seluruh *process
//!   group* anak saat future koneksi di-drop, sehingga proses anak tidak bocor.

pub mod client;

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    ClientCapabilities, Implementation, InitializeRequest, InitializeResponse,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::agents::AgentSpec;

/// Berapa lama `shutdown` menunggu koneksi selesai sebelum task-nya dibatalkan.
/// Crate sendiri memberi anaknya masa tenggang 1 detik setelah protokol tutup,
/// jadi ini harus lebih longgar dari itu.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Kegagalan saat menyambung ke satu adapter ACP.
#[derive(Debug)]
pub enum AcpError {
    /// Koneksi atau handshake gagal di tingkat protokol.
    Protocol(agent_client_protocol::Error),
    /// Koneksi berakhir sebelum `initialize` sempat dijawab.
    ConnectionClosed(String),
}

impl fmt::Display for AcpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "protokol ACP gagal: {error}"),
            Self::ConnectionClosed(detail) => {
                write!(f, "koneksi ACP tertutup sebelum initialize selesai: {detail}")
            }
        }
    }
}

impl std::error::Error for AcpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::ConnectionClosed(_) => None,
        }
    }
}

impl From<agent_client_protocol::Error> for AcpError {
    fn from(error: agent_client_protocol::Error) -> Self {
        Self::Protocol(error)
    }
}

/// Pembacaan ringkas atas balasan `initialize`.
///
/// Sengaja didefinisikan di sini (bukan dipakai langsung dari crate) supaya kode
/// pemanggil dan test tidak bergantung pada bentuk internal
/// [`InitializeResponse`] yang `#[non_exhaustive]`.
pub trait InitializeResponseExt {
    /// `agentInfo.name` dari agen, atau string kosong bila agen tidak mengirimnya.
    fn agent_info_name(&self) -> &str;

    /// Apakah agen menerima `ContentBlock::Image` di dalam `session/prompt`.
    fn supports_image_prompt(&self) -> bool;
}

impl InitializeResponseExt for InitializeResponse {
    fn agent_info_name(&self) -> &str {
        self.agent_info
            .as_ref()
            .map_or("", |info| info.name.as_str())
    }

    fn supports_image_prompt(&self) -> bool {
        self.agent_capabilities.prompt_capabilities.image
    }
}

/// Koneksi hidup ke satu proses adapter ACP.
///
/// Men-drop handle ini juga mematikan proses anak: `shutdown_tx` ikut ter-drop,
/// closure koneksi bangun, dan `ChildGuard` milik crate membunuh process group.
/// [`AcpHandle::shutdown`] melakukan hal yang sama tetapi menunggu sampai selesai.
pub struct AcpHandle {
    connection: ConnectionTo<Agent>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    runner: JoinHandle<Result<(), agent_client_protocol::Error>>,
    cwd: PathBuf,
}

impl fmt::Debug for AcpHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AcpHandle")
            .field("cwd", &self.cwd)
            .finish_non_exhaustive()
    }
}

impl AcpHandle {
    /// Koneksi ke agen, untuk mengirim request lanjutan (`session/new`, dll).
    #[must_use]
    pub fn connection(&self) -> &ConnectionTo<Agent> {
        &self.connection
    }

    /// Direktori kerja yang diminta pemanggil.
    ///
    /// ACP tidak menaruh cwd di proses adapter — `AcpAgentConfig` hanya punya
    /// `command`/`args`/`env` — melainkan di `session/new`. Nilainya disimpan di
    /// sini supaya pembuat sesi nanti memakai cwd yang sama.
    #[must_use]
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Tutup koneksi dan tunggu proses anak benar-benar mati.
    pub async fn shutdown(mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }

        if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut self.runner)
            .await
            .is_err()
        {
            // Membatalkan task akan men-drop future koneksi, dan drop itulah yang
            // memicu SIGKILL ke process group anak. Tunggu pembatalannya selesai
            // supaya drop sudah benar-benar dijalankan saat fungsi ini kembali.
            self.runner.abort();
            drop((&mut self.runner).await);
        }
    }
}

/// Jalankan biner adapter milik `spec` dan selesaikan handshake `initialize`.
///
/// `cwd` tidak dipakai untuk men-spawn proses (lihat [`AcpHandle::cwd`]); ia
/// disimpan untuk `session/new` pada task berikutnya.
///
/// # Errors
///
/// Mengembalikan [`AcpError`] bila proses gagal dijalankan, transport putus,
/// atau agen menolak `initialize`.
pub async fn connect(
    spec: &AgentSpec,
    cwd: &Path,
) -> Result<(AcpHandle, InitializeResponse), AcpError> {
    let agent = AcpAgent::new(AcpAgentConfig::new(spec.bin));

    let (ready_tx, ready_rx) =
        oneshot::channel::<Result<(ConnectionTo<Agent>, InitializeResponse), agent_client_protocol::Error>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let runner = tokio::spawn(async move {
        client::builder()
            .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
                let request = InitializeRequest::new(ProtocolVersion::V1)
                    .client_capabilities(ClientCapabilities::default())
                    .client_info(Implementation::new(
                        client::CLIENT_NAME,
                        env!("CARGO_PKG_VERSION"),
                    ));

                match cx.send_request(request).block_task().await {
                    Ok(response) => {
                        if ready_tx.send(Ok((cx.clone(), response))).is_err() {
                            // Pemanggil sudah pergi; tutup koneksi.
                            return Ok(());
                        }
                    }
                    Err(error) => {
                        drop(ready_tx.send(Err(error)));
                        return Ok(());
                    }
                }

                // Tahan koneksi tetap hidup sampai `shutdown` (atau `AcpHandle`
                // yang di-drop) menutup channel ini.
                drop(shutdown_rx.await);
                Ok(())
            })
            .await
    });

    match ready_rx.await {
        Ok(Ok((connection, response))) => Ok((
            AcpHandle {
                connection,
                shutdown_tx: Some(shutdown_tx),
                runner,
                cwd: cwd.to_path_buf(),
            },
            response,
        )),
        Ok(Err(error)) => {
            drop(shutdown_tx);
            drop(runner.await);
            Err(AcpError::Protocol(error))
        }
        Err(_) => {
            // Closure tidak pernah mengirim apa pun: koneksi gagal lebih dulu.
            drop(shutdown_tx);
            match runner.await {
                Ok(Ok(())) => Err(AcpError::ConnectionClosed(
                    "koneksi berakhir tanpa balasan initialize".to_owned(),
                )),
                Ok(Err(error)) => Err(AcpError::Protocol(error)),
                Err(join_error) => Err(AcpError::ConnectionClosed(join_error.to_string())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{AgentCapabilities, PromptCapabilities};

    #[test]
    fn agent_info_name_kosong_bila_agen_tak_mengirim_info() {
        let response = InitializeResponse::new(ProtocolVersion::V1);
        assert_eq!(response.agent_info_name(), "");
    }

    #[test]
    fn agent_info_name_membaca_nama_implementasi() {
        let response = InitializeResponse::new(ProtocolVersion::V1)
            .agent_info(Implementation::new("claude-agent-acp", "0.64.2"));
        assert_eq!(response.agent_info_name(), "claude-agent-acp");
    }

    #[test]
    fn supports_image_prompt_membaca_kapabilitas_gambar() {
        let tanpa_gambar = InitializeResponse::new(ProtocolVersion::V1);
        assert!(!tanpa_gambar.supports_image_prompt());

        let dengan_gambar = InitializeResponse::new(ProtocolVersion::V1).agent_capabilities(
            AgentCapabilities::new().prompt_capabilities(PromptCapabilities::new().image(true)),
        );
        assert!(dengan_gambar.supports_image_prompt());
    }
}
