use std::path::PathBuf;
use std::time::Duration;

use app_lib::acp::AcpError;
use app_lib::agents::AgentSpec;

fn akar_repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

#[test]
fn konfigurasi_sidecar_tidak_menyertakan_field_type() {
    let cfg = app_lib::sidecar::midscene_server(&akar_repo());
    let json = serde_json::to_value(&cfg).unwrap();
    assert!(
        json.get("type").is_none(),
        "entri stdio harus tanpa field type, dapat: {json}"
    );
    assert_eq!(json["name"], "midscene");
    let args = json["args"].as_array().expect("args harus array");
    assert!(
        args.iter()
            .any(|a| a.as_str().unwrap_or("").contains("--env-file"))
    );
    assert!(
        args.iter()
            .any(|a| a.as_str().unwrap_or("").ends_with("midscene-mcp/src/index.ts"))
    );
}

/// Path sidecar yang salah gagal dengan **diam dan hijau**, jadi harus dijaga
/// terpisah.
///
/// `midscene_server` sengaja infallible (sesuai brief): ia hanya merangkai path,
/// dan yang men-spawn prosesnya adalah agen, bukan kita. Konsekuensinya, bila
/// repo dipindah atau aplikasi dipaketkan tanpa `midscene-mcp/`, `node` keluar
/// seketika dengan ENOENT, `claude-agent-acp` **tetap** mengembalikan sessionId
/// yang sah, dan `sesi_baru_membuat_id_sesi` tetap lulus — sementara agen tidak
/// punya satu pun dari sepuluh tool Midscene. Itu persis kelas regresi yang
/// menjadi alasan task ini ada.
///
/// Karena itu keberadaan kedua path diperiksa di sini, bukan di dalam
/// `midscene_server`: pemeriksaannya jadi milik test, tanda tangan fungsinya
/// tetap infallible, dan tata letak yang rusak gagal dengan berisik.
#[test]
fn path_sidecar_benar_benar_ada() {
    let akar = akar_repo();

    let env_file = akar.join(".env");
    assert!(
        env_file.is_file(),
        "node --env-file akan gagal seketika: {} tidak ada",
        env_file.display()
    );

    let entry = akar.join("midscene-mcp/src/index.ts");
    assert!(
        entry.is_file(),
        "sidecar tidak akan pernah menyala: {} tidak ada",
        entry.display()
    );
}

#[tokio::test]
async fn sesi_baru_membuat_id_sesi() {
    let spec = app_lib::agents::find_agent("claude").unwrap();
    let akar = akar_repo();
    let (handle, _init) = app_lib::acp::connect(spec, &akar).await.unwrap();
    let servers = vec![app_lib::sidecar::midscene_server(&akar)];
    let sid = app_lib::acp::new_session(&handle, &akar, servers)
        .await
        .unwrap();
    assert!(!sid.to_string().is_empty(), "sessionId tidak boleh kosong");
    handle.shutdown().await;
}

/// Adapter yang sehat sampai handshake lalu membisu tidak boleh menggantung
/// `new_session` selamanya.
///
/// Ini kembaran `connect_menyerah_bila_adapter_tak_pernah_menjawab` satu fase
/// lebih dalam. Trik `tail` milik test itu tidak bisa dipakai ulang: `tail`
/// gugur sudah di `initialize` dan tidak pernah sampai ke `session/new`. Fixture
/// `agen-bisu-setelah-initialize.mjs` menjawab `initialize` dengan benar lalu
/// diam untuk sisanya — tidak ada balasan, tidak ada EOF — meniru server MCP
/// yang di-spawn agen tapi tidak pernah siap. Anggarannya dipendekkan lewat
/// suntikan supaya suite tidak ikut menunggu dua menit.
#[tokio::test]
async fn new_session_menyerah_bila_agen_tak_pernah_menjawab() {
    let bisu = AgentSpec {
        id: "bisu",
        label: "Adapter bisu setelah initialize",
        bin: concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/agen-bisu-setelah-initialize.mjs"
        ),
    };
    let akar = akar_repo();
    let anggaran = Duration::from_millis(400);

    let (handle, _init) = app_lib::acp::connect(&bisu, &akar)
        .await
        .expect("fixture harus lulus handshake");

    let mulai = std::time::Instant::now();
    let hasil = app_lib::acp::new_session_with_timeout(&handle, &akar, Vec::new(), anggaran).await;
    let berlalu = mulai.elapsed();

    match hasil {
        Err(AcpError::SessionTimeout(dipakai)) => assert_eq!(dipakai, anggaran),
        other => panic!("harusnya SessionTimeout, dapat {other:?}"),
    }

    assert!(
        berlalu < Duration::from_secs(5),
        "new_session harus menyerah mendekati anggarannya, bukan setelah {berlalu:?}"
    );

    handle.shutdown().await;
}
