use agent_client_protocol::schema::v1::{PermissionOption, PermissionOptionId, PermissionOptionKind};

/// Choose an option that genuinely means "allow", for full-permissions mode.
///
/// Returns `None` when the agent offered nothing that clearly allows. The caller
/// MUST fall back to asking the user in that case. Approving something that is not
/// an approval is worse than asking — and `PermissionOptionKind` is
/// `#[non_exhaustive]`, so unknown kinds must never be treated as consent.
///
/// `AllowOnce` wins over `AllowAlways`: this mode is already a standing decision
/// by the user, so it should not additionally teach the agent to remember consent
/// on its own side.
pub fn pick_allow(options: &[PermissionOption]) -> Option<PermissionOptionId> {
    let by_kind = |wanted: PermissionOptionKind| {
        options
            .iter()
            .find(|o| o.kind == wanted)
            .map(|o| o.option_id.clone())
    };
    by_kind(PermissionOptionKind::AllowOnce).or_else(|| by_kind(PermissionOptionKind::AllowAlways))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{
        PermissionOption, PermissionOptionId, PermissionOptionKind,
    };

    fn opsi(id: &str, kind: PermissionOptionKind) -> PermissionOption {
        // `PermissionOptionId` is `#[non_exhaustive]`, so its tuple constructor
        // cannot be called from outside the defining crate even though the
        // inner field is `pub`; use the provided `new` associated function.
        PermissionOption::new(PermissionOptionId::new(id), id.to_string(), kind)
    }

    #[test]
    fn memilih_allow_once_bila_tersedia() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectOnce),
            opsi("izinkan", PermissionOptionKind::AllowOnce),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "izinkan");
    }

    #[test]
    fn memilih_allow_always_bila_itu_satu_satunya_izin() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectAlways),
            opsi("selalu", PermissionOptionKind::AllowAlways),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "selalu");
    }

    #[test]
    fn allow_once_didahulukan_atas_allow_always() {
        let daftar = vec![
            opsi("selalu", PermissionOptionKind::AllowAlways),
            opsi("sekali", PermissionOptionKind::AllowOnce),
        ];
        assert_eq!(pick_allow(&daftar).unwrap().0.as_ref(), "sekali");
    }

    #[test]
    fn tanpa_opsi_izin_mengembalikan_none() {
        let daftar = vec![
            opsi("tolak", PermissionOptionKind::RejectOnce),
            opsi("tolak-selalu", PermissionOptionKind::RejectAlways),
        ];
        assert!(pick_allow(&daftar).is_none());
    }

    #[test]
    fn daftar_kosong_mengembalikan_none() {
        assert!(pick_allow(&[]).is_none());
    }
}
