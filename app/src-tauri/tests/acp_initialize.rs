use app_lib::acp::{AcpError, ClientContext, InitializeResponseExt};
use app_lib::agents::AgentSpec;
use std::path::Path;
use std::time::Duration;

#[tokio::test]
async fn initialize_mengembalikan_info_agen_dan_kapabilitas() {
    let spec = app_lib::agents::find_agent("claude").expect("agen claude harus ada");
    // ACP mewajibkan cwd sesi berupa path absolut.
    let cwd = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (handle, init) = app_lib::acp::connect(spec, cwd, ClientContext::silent())
        .await
        .expect("connect harus berhasil");

    assert!(
        init.agent_info_name().contains("claude-agent-acp"),
        "agentInfo.name tak terduga: {}",
        init.agent_info_name()
    );
    assert!(init.supports_image_prompt(), "agen harus mendukung prompt gambar");

    assert!(
        handle.cwd().is_absolute(),
        "cwd yang disimpan wajib absolut, dapat {}",
        handle.cwd().display()
    );

    handle.shutdown().await;
}

/// Adapter yang hidup tapi membisu tidak boleh menggantung `connect` selamanya.
///
/// `tail` tanpa argumen adalah pengganti yang tepat: ia membaca stdin, tidak
/// menulis apa pun ke stdout selama stdin masih terbuka, dan tetap hidup — jadi
/// tidak ada balasan dan tidak ada EOF, persis kondisi yang membuat `block_task`
/// menunggu tanpa akhir. Anggarannya dibuat pendek lewat `connect_with_timeout`
/// supaya suite normal tidak ikut melambat.
#[tokio::test]
async fn connect_menyerah_bila_adapter_tak_pernah_menjawab() {
    let diam = AgentSpec {
        id: "diam",
        label: "Adapter membisu",
        bin: "/usr/bin/tail",
    };
    let anggaran = Duration::from_millis(400);

    let mulai = std::time::Instant::now();
    let hasil =
        app_lib::acp::connect_with_timeout(
            &diam,
            Path::new(env!("CARGO_MANIFEST_DIR")),
            ClientContext::silent(),
            anggaran,
        )
            .await;
    let berlalu = mulai.elapsed();

    match hasil {
        Err(AcpError::HandshakeTimeout(dipakai)) => assert_eq!(dipakai, anggaran),
        other => panic!("harusnya HandshakeTimeout, dapat {other:?}"),
    }

    assert!(
        berlalu < Duration::from_secs(5),
        "connect harus menyerah mendekati anggarannya, bukan setelah {berlalu:?}"
    );
}

#[tokio::test]
async fn connect_menolak_cwd_yang_tidak_ada() {
    let spec = app_lib::agents::find_agent("claude").expect("agen claude harus ada");
    let hilang = Path::new("/jalur/yang/pasti/tidak/ada/midscene-desktop");

    match app_lib::acp::connect(spec, hilang, ClientContext::silent()).await {
        Err(AcpError::InvalidCwd { path, .. }) => assert_eq!(path, hilang),
        other => panic!("harusnya InvalidCwd, dapat {other:?}"),
    }
}
