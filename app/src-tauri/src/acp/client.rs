//! Sisi klien ACP: apa yang agen boleh minta dari *kita*.
//!
//! Catatan API penting: crate `agent-client-protocol` 2.0.0 **tidak** punya trait
//! `Client` yang kita implementasikan (tidak ada `impl Client for X`). Peran klien
//! diwujudkan lewat `Builder` berbasis closure:
//! `Client.builder().on_receive_request(..).on_receive_notification(..)`.
//! `agent_client_protocol::Client` adalah *marker role* (`pub struct Client;`
//! dengan `impl Role for Client { type Counterpart = Agent; .. }`), bukan trait
//! yang menuntut method wajib. Jadi file ini berisi "implementasi peran klien"
//! dalam bentuk builder + handler, bukan blok `impl Trait`.
//!
//! Permintaan yang tidak punya handler dibalas otomatis oleh crate dengan error
//! JSON-RPC `method not found` (lihat `jsonrpc/incoming_actor.rs`:
//! `"Rejecting request with error, no handler"`), jadi agen tidak menggantung.
//! Kita tetap menangani `session/request_permission` secara eksplisit karena
//! itu satu-satunya permintaan yang pasti muncul di alur normal.

use agent_client_protocol::schema::v1::{
    PermissionOptionKind, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use agent_client_protocol::{
    Agent, Builder, Client, HandleDispatchFrom, NullClose, NullRun, on_receive_request,
};

/// Nama klien yang dikirim ke agen pada `initialize`.
pub const CLIENT_NAME: &str = "midscene-desktop";

/// Bangun builder koneksi untuk peran klien, lengkap dengan handler-handlernya.
///
/// Untuk Task 3 gerbang izin **menolak semua** permintaan, tetapi selalu dengan
/// jawaban terstruktur yang sah. Task 6 menggantinya dengan gerbang sungguhan.
pub fn builder() -> Builder<Client, impl HandleDispatchFrom<Agent>, NullRun, NullClose> {
    Client
        .builder()
        .name(CLIENT_NAME)
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                responder.respond(refuse(&request))
            },
            on_receive_request!(),
        )
}

/// Susun penolakan terstruktur untuk satu permintaan izin.
///
/// Utamakan opsi bertipe `RejectOnce` (menolak sekali, tidak diingat), lalu
/// `RejectAlways`. Bila agen sama sekali tidak menawarkan opsi penolakan,
/// jawab `Cancelled` — tetap balasan yang sah, bukan panik dan bukan diam.
fn refuse(request: &RequestPermissionRequest) -> RequestPermissionResponse {
    let reject = request
        .options
        .iter()
        .find(|option| matches!(option.kind, PermissionOptionKind::RejectOnce))
        .or_else(|| {
            request
                .options
                .iter()
                .find(|option| matches!(option.kind, PermissionOptionKind::RejectAlways))
        });

    match reject {
        Some(option) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option.option_id.clone()),
        )),
        None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        PermissionOption, ToolCallUpdate, ToolCallUpdateFields,
    };

    fn permintaan(options: Vec<PermissionOption>) -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "sesi-uji",
            ToolCallUpdate::new("tool-1", ToolCallUpdateFields::new()),
            options,
        )
    }

    #[test]
    fn menolak_dengan_opsi_reject_once_bila_ada() {
        let request = permintaan(vec![
            PermissionOption::new("ya", "Izinkan", PermissionOptionKind::AllowOnce),
            PermissionOption::new("tidak", "Tolak", PermissionOptionKind::RejectOnce),
            PermissionOption::new("tidak-selalu", "Tolak selalu", PermissionOptionKind::RejectAlways),
        ]);

        match refuse(&request).outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "tidak");
            }
            other => panic!("harusnya memilih opsi penolakan, dapat {other:?}"),
        }
    }

    #[test]
    fn mundur_ke_reject_always_bila_reject_once_tidak_ada() {
        let request = permintaan(vec![
            PermissionOption::new("ya", "Izinkan", PermissionOptionKind::AllowOnce),
            PermissionOption::new("tidak-selalu", "Tolak selalu", PermissionOptionKind::RejectAlways),
        ]);

        match refuse(&request).outcome {
            RequestPermissionOutcome::Selected(selected) => {
                assert_eq!(selected.option_id.0.as_ref(), "tidak-selalu");
            }
            other => panic!("harusnya memilih opsi penolakan, dapat {other:?}"),
        }
    }

    #[test]
    fn menjawab_cancelled_bila_tak_ada_opsi_penolakan() {
        let request = permintaan(vec![PermissionOption::new(
            "ya",
            "Izinkan",
            PermissionOptionKind::AllowOnce,
        )]);

        assert!(matches!(
            refuse(&request).outcome,
            RequestPermissionOutcome::Cancelled
        ));
    }

    #[test]
    fn menjawab_cancelled_bila_daftar_opsi_kosong() {
        assert!(matches!(
            refuse(&permintaan(vec![])).outcome,
            RequestPermissionOutcome::Cancelled
        ));
    }
}
