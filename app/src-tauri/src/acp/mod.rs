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

/// Batas waktu bawaan untuk menunggu balasan `initialize`.
///
/// Crate tidak punya jaring pengaman apa pun di sini: `block_task` hanya selesai
/// bila ada balasan, pembatalan, atau EOF dari anak. Adapter yang hidup tapi
/// membisu (tersangkut prompt TTY, resolusi modul macet, credential helper
/// menggantung) tidak menghasilkan EOF, jadi tanpa batas ini `connect` menunggu
/// selamanya dan Task 4 akan punya promise yang tak pernah selesai.
///
/// 30 detik dipilih agar jauh di atas jalur lambat yang sah — adapter yang
/// dijalankan lewat `npx` bisa mengunduh dan memuat modul lebih dari sepuluh
/// detik pada start dingin — sekaligus tetap terbatas. Timeout palsu jauh lebih
/// merusak daripada spinner panjang: ia membuat aplikasi tak bisa dipakai sama
/// sekali. Bandingkan dengan dua anggaran lain di sistem ini, yang mengukur hal
/// yang sepenuhnya berbeda (pembersihan, bukan start dingin): masa tenggang anak
/// milik crate 1 detik (`src/acp_agent.rs:24`) dan [`SHUTDOWN_TIMEOUT`] 5 detik.
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Kegagalan saat menyambung ke satu adapter ACP.
#[derive(Debug)]
pub enum AcpError {
    /// Koneksi atau handshake gagal di tingkat protokol.
    Protocol(agent_client_protocol::Error),
    /// Koneksi berakhir sebelum `initialize` sempat dijawab.
    ConnectionClosed(String),
    /// Adapter hidup tetapi tidak menjawab `initialize` dalam batas waktu.
    HandshakeTimeout(Duration),
    /// `cwd` tidak bisa dijadikan path absolut yang sah.
    InvalidCwd {
        /// Path yang diberikan pemanggil.
        path: PathBuf,
        /// Kegagalan dari sistem berkas.
        source: std::io::Error,
    },
}

impl fmt::Display for AcpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "protokol ACP gagal: {error}"),
            Self::ConnectionClosed(detail) => {
                write!(f, "koneksi ACP tertutup sebelum initialize selesai: {detail}")
            }
            Self::HandshakeTimeout(budget) => write!(
                f,
                "adapter tidak menjawab initialize dalam {budget:?}",
            ),
            Self::InvalidCwd { path, source } => write!(
                f,
                "direktori kerja {} tidak bisa dipakai: {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for AcpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Protocol(error) => Some(error),
            Self::InvalidCwd { source, .. } => Some(source),
            Self::ConnectionClosed(_) | Self::HandshakeTimeout(_) => None,
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

/// Ubah `cwd` yang diberikan pemanggil menjadi path absolut yang sah.
///
/// ACP mewajibkan cwd sesi berupa path absolut — skema menyebutnya eksplisit
/// (`agent-client-protocol-schema-1.5.0/src/v1/agent.rs:1012`: *"The working
/// directory for this session. Must be an absolute path."*).
///
/// Dipakai [`std::fs::canonicalize`], yang **mensyaratkan path itu ada**, bukan
/// [`std::path::absolute`] yang menerima apa saja. Itu keputusan sengaja: cwd
/// sesi yang tidak ada tidak akan pernah menjadi sesi yang benar. Melaporkannya
/// di sini, di batas tempat nilainya masuk, memberi pesan yang menyebut path
/// yang salah. Bila dibiarkan lewat, kegagalannya muncul jauh kemudian sebagai
/// penolakan `session/new` yang membingungkan — atau, lebih buruk, agen
/// menyelesaikannya terhadap cwd warisannya sendiri dan sesi diam-diam terikat
/// ke pohon direktori yang salah. Canonicalize juga menyelesaikan symlink dan
/// `..`, sehingga sesi punya identitas direktori yang stabil.
fn resolve_cwd(cwd: &Path) -> Result<PathBuf, AcpError> {
    cwd.canonicalize().map_err(|source| AcpError::InvalidCwd {
        path: cwd.to_path_buf(),
        source,
    })
}

/// Jalankan biner adapter milik `spec` dan selesaikan handshake `initialize`,
/// dengan batas waktu handshake bawaan [`DEFAULT_HANDSHAKE_TIMEOUT`].
///
/// # Errors
///
/// Lihat [`connect_with_timeout`].
pub async fn connect(
    spec: &AgentSpec,
    cwd: &Path,
) -> Result<(AcpHandle, InitializeResponse), AcpError> {
    connect_with_timeout(spec, cwd, DEFAULT_HANDSHAKE_TIMEOUT).await
}

/// Seperti [`connect`], tetapi dengan batas waktu handshake yang ditentukan
/// pemanggil. Terutama berguna untuk test, yang tidak boleh menunggu puluhan
/// detik hanya untuk membuktikan batas waktunya bekerja.
///
/// `cwd` tidak dipakai untuk men-spawn proses (lihat [`AcpHandle::cwd`]); ia
/// dijadikan absolut lalu disimpan untuk `session/new` pada task berikutnya.
///
/// # Errors
///
/// Mengembalikan [`AcpError`] bila `cwd` tidak sah, proses gagal dijalankan,
/// transport putus, agen menolak `initialize`, atau adapter tidak menjawab
/// dalam `handshake_timeout`.
pub async fn connect_with_timeout(
    spec: &AgentSpec,
    cwd: &Path,
    handshake_timeout: Duration,
) -> Result<(AcpHandle, InitializeResponse), AcpError> {
    let cwd = resolve_cwd(cwd)?;
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

    let ready = match tokio::time::timeout(handshake_timeout, ready_rx).await {
        Ok(ready) => ready,
        Err(_) => {
            // Adapter hidup tapi membisu: tidak akan ada EOF, jadi tidak akan
            // pernah ada error. Batalkan task — drop future koneksi itulah yang
            // memicu SIGKILL ke process group anak — lalu tunggu pembatalannya
            // selesai supaya anak sudah direbut saat kita kembali.
            drop(shutdown_tx);
            runner.abort();
            drop(runner.await);
            return Err(AcpError::HandshakeTimeout(handshake_timeout));
        }
    };

    match ready {
        Ok(Ok((connection, response))) => Ok((
            AcpHandle {
                connection,
                shutdown_tx: Some(shutdown_tx),
                runner,
                cwd,
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
    fn resolve_cwd_menjadikan_path_relatif_absolut() {
        let resolved = resolve_cwd(Path::new(".")).expect("direktori saat ini harus ada");

        assert!(
            resolved.is_absolute(),
            "cwd wajib absolut menurut skema ACP, dapat {}",
            resolved.display()
        );
        assert!(resolved.is_dir());
    }

    #[test]
    fn resolve_cwd_membiarkan_path_absolut_tetap_absolut() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let resolved = resolve_cwd(manifest).expect("direktori manifest harus ada");

        assert!(resolved.is_absolute());
        assert_eq!(
            resolved,
            manifest
                .canonicalize()
                .expect("direktori manifest harus bisa di-canonicalize")
        );
    }

    #[test]
    fn resolve_cwd_menolak_path_yang_tidak_ada() {
        let hilang = Path::new("/jalur/yang/pasti/tidak/ada/midscene-desktop");

        match resolve_cwd(hilang) {
            Err(AcpError::InvalidCwd { path, source }) => {
                assert_eq!(path, hilang);
                assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
            }
            other => panic!("harusnya InvalidCwd, dapat {other:?}"),
        }
    }

    #[test]
    fn pesan_invalid_cwd_menyebut_path_yang_salah() {
        let error = resolve_cwd(Path::new("/jalur/yang/pasti/tidak/ada/midscene-desktop"))
            .expect_err("harus gagal");

        assert!(
            error.to_string().contains("/jalur/yang/pasti/tidak/ada"),
            "pesan harus menyebut path yang salah: {error}"
        );
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
