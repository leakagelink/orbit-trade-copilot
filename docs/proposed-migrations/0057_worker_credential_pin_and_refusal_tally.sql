-- =====================================================================================================================
-- 0057 — DRAFT ONLY. NOT APPLIED. PROPOSED NUMBER; the final number is assigned at owner approval, after the hosted
-- migration history has been read (applied history ends at drizzle 0039; drafts 0040–0056 are unapplied).
-- Successor of draft 0056. Apply order: 0049 → … → 0055 → 0056 → 0057. Rollback order: 0057 → 0056 → … → 0049.
-- 0049–0056 are left byte-identical. Phase 4H.7 remediation of docs/phase-4h6 blockers 2 and 3:
--
--  Credential change (F15.7). Registration pins a SHA-256 fingerprint of the worker's sign-in details in auth.users
--      (email, password hash, pending email/phone changes, recovery/reauthentication requests, phone, ban, deletion,
--      SSO/anonymous flags, role/audience, provider metadata) and auth.identities (provider, provider id, email), read
--      only. Every worker call (fpw_id_check) refuses when the fingerprint differs or the session was created before
--      the pin. The first such refusal disables the identity, revokes every enrollment and ends its leases (sticky:
--      changing the details back restores nothing; an admin must re-register and owners must re-enroll). Ordinary sign-in
--      events (last_sign_in_at, updated_at, identity_data) are deliberately NOT in the fingerprint. Identities registered
--      before 0057 have no pin and are refused until re-registered. Auth settings and ordinary users are unchanged;
--      nothing is written to auth.*.
--  Refusal completeness (F13.2/F13.3). A per-identity tally counts every refusal row written and every refusal dropped
--      above the cap (monotonic counters; never deleted); fpw_audit_refusal_completeness (admin + MFA) reports rows,
--      recorded_total, missing (= deleted rows) and dropped_total. Refusals that never reach database code (request
--      hook, privilege errors, rejected tokens, statement timeouts) cannot be recorded here: see
--      docs/phase-4h7/audit-integrity-report.md (platform-log category B).
-- ONE statement (a single DO block): all-or-nothing whatever the runner does. Creates no user, credential, schedule or
-- route; grants nothing new to API roles except EXECUTE on the admin-only completeness report.
-- =====================================================================================================================
DO $mig$
BEGIN
  -- ---------- preconditions (fail closed) ----------
  IF to_regprocedure('public.fpw_api_pre_request()') IS NULL OR to_regclass('public.futures_paper_0055_requires_0054') IS NULL
     OR to_regclass('public.futures_paper_worker_refusals') IS NULL OR to_regprocedure('public.fpw_cp_field(text)') IS NULL THEN
    RAISE EXCEPTION '0057 requires draft 0056 (and through it drafts 0049–0055)';
  END IF;
  IF to_regclass('auth.users') IS NULL OR to_regclass('auth.identities') IS NULL THEN RAISE EXCEPTION '0057 requires auth.users and auth.identities'; END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'auth.users'::regclass AND attnum > 0 AND NOT attisdropped AND attname IN ('id', 'email', 'encrypted_password',
        'email_change', 'email_change_sent_at', 'phone', 'phone_change', 'phone_change_sent_at', 'recovery_sent_at', 'reauthentication_sent_at', 'banned_until',
        'deleted_at', 'is_sso_user', 'is_anonymous', 'role', 'aud', 'raw_app_meta_data')) <> 17
     OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'auth.identities'::regclass AND attnum > 0 AND NOT attisdropped AND attname IN ('user_id', 'provider', 'provider_id', 'email')) <> 4 THEN
    RAISE EXCEPTION '0057 refuses: auth.users / auth.identities lack a sign-in column the credential fingerprint reads (review the hosted schema first)';
  END IF;
  IF to_regclass('public.futures_paper_worker_credential_pins') IS NOT NULL OR to_regclass('public.futures_paper_worker_credential_pins_0057_retired') IS NOT NULL
     OR to_regclass('public.futures_paper_worker_credential_events') IS NOT NULL OR to_regclass('public.futures_paper_worker_credential_events_0057_retired') IS NOT NULL
     OR to_regclass('public.futures_paper_worker_refusal_tally') IS NOT NULL OR to_regclass('public.futures_paper_worker_refusal_tally_0057_retired') IS NOT NULL THEN
    RAISE EXCEPTION '0057 refuses: tables from an earlier 0057 application exist (review them first)';
  END IF;

  -- ---------- credential fingerprint (read-only on auth.*) ----------
  CREATE FUNCTION public.fpw_credential_pin(p_user uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $f$
    SELECT encode(sha256(convert_to(concat_ws('|', 'fpw-credential-v1',
             public.fpw_cp_field(u.id::text), public.fpw_cp_field(u.email::text), public.fpw_cp_field(u.encrypted_password::text),
             public.fpw_cp_field(u.email_change::text), public.fpw_cp_field(public.fpw_cp_us(u.email_change_sent_at)),
             public.fpw_cp_field(u.phone::text), public.fpw_cp_field(u.phone_change::text), public.fpw_cp_field(public.fpw_cp_us(u.phone_change_sent_at)),
             public.fpw_cp_field(public.fpw_cp_us(u.recovery_sent_at)), public.fpw_cp_field(public.fpw_cp_us(u.reauthentication_sent_at)),
             public.fpw_cp_field(public.fpw_cp_us(u.banned_until)), public.fpw_cp_field(public.fpw_cp_us(u.deleted_at)),
             public.fpw_cp_field(u.is_sso_user::text), public.fpw_cp_field(u.is_anonymous::text), public.fpw_cp_field(u.role::text), public.fpw_cp_field(u.aud::text),
             public.fpw_cp_field((u.raw_app_meta_data -> 'provider')::text), public.fpw_cp_field((u.raw_app_meta_data -> 'providers')::text),
             public.fpw_cp_field((SELECT string_agg(public.fpw_cp_field(i.provider) || ':' || public.fpw_cp_field(i.provider_id) || ':' || public.fpw_cp_field(i.email), ','
                                         ORDER BY i.provider, i.provider_id) FROM auth.identities i WHERE i.user_id = u.id))), 'UTF8')), 'hex')
      FROM auth.users u WHERE u.id = p_user
  $f$;

  -- ---------- tables (no API grants; written only by the functions below; history is never deleted) ----------
  CREATE TABLE public.futures_paper_worker_credential_pins (
    worker_user_id uuid PRIMARY KEY,
    pin text NOT NULL CHECK (pin ~ '^[0-9a-f]{64}$'),
    pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    pinned_by uuid NOT NULL
  );
  CREATE TRIGGER futures_paper_worker_credential_pins_no_delete BEFORE DELETE ON public.futures_paper_worker_credential_pins FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
  CREATE TRIGGER futures_paper_worker_credential_pins_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_credential_pins FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
  CREATE TABLE public.futures_paper_worker_credential_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_user_id uuid NOT NULL,
    event text NOT NULL CHECK (event IN ('PINNED', 'CHANGE_DETECTED')),
    pin text CHECK (pin IS NULL OR pin ~ '^[0-9a-f]{64}$'),
    observed text CHECK (observed IS NULL OR observed ~ '^[0-9a-f]{64}$'),
    enrollments_revoked integer NOT NULL DEFAULT 0 CHECK (enrollments_revoked >= 0),
    actor uuid NOT NULL,
    session_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX futures_paper_worker_credential_events_worker ON public.futures_paper_worker_credential_events (worker_user_id, id);
  CREATE TRIGGER futures_paper_worker_credential_events_immutable BEFORE UPDATE OR DELETE ON public.futures_paper_worker_credential_events FOR EACH ROW EXECUTE FUNCTION public.futures_paper_history_immutable();
  CREATE TRIGGER futures_paper_worker_credential_events_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_credential_events FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();
  CREATE TABLE public.futures_paper_worker_refusal_tally (
    worker_user_id uuid PRIMARY KEY,
    baseline_rows bigint NOT NULL CHECK (baseline_rows >= 0),
    recorded_total bigint NOT NULL CHECK (recorded_total >= baseline_rows),
    dropped_total bigint NOT NULL DEFAULT 0 CHECK (dropped_total >= 0),
    first_dropped_at timestamptz,
    last_dropped_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE FUNCTION public.fpw_refusal_tally_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $f$
  BEGIN
    IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'futures paper worker refusal tally: counters are never deleted'; END IF;
    IF NEW.worker_user_id <> OLD.worker_user_id OR NEW.baseline_rows <> OLD.baseline_rows OR NEW.recorded_total < OLD.recorded_total
       OR NEW.dropped_total < OLD.dropped_total OR (OLD.first_dropped_at IS NOT NULL AND NEW.first_dropped_at IS DISTINCT FROM OLD.first_dropped_at) THEN
      RAISE EXCEPTION 'futures paper worker refusal tally: counters only increase';
    END IF;
    RETURN NEW;
  END $f$;
  CREATE TRIGGER futures_paper_worker_refusal_tally_monotonic BEFORE UPDATE OR DELETE ON public.futures_paper_worker_refusal_tally FOR EACH ROW EXECUTE FUNCTION public.fpw_refusal_tally_guard();
  CREATE TRIGGER futures_paper_worker_refusal_tally_no_truncate BEFORE TRUNCATE ON public.futures_paper_worker_refusal_tally FOR EACH STATEMENT EXECUTE FUNCTION public.futures_paper_history_immutable();

  -- ---------- registry, per-call check and refusal recorder (0055 bodies + the 0057 additions) ----------
  CREATE OR REPLACE FUNCTION public.fpw_admin_set_identity(p_worker uuid, p_label text, p_enabled boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); w public.futures_paper_worker_identities%ROWTYPE; v_found boolean; v_pin text;
  BEGIN
    IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper worker identity: admin only'; END IF;
    IF p_worker IS NULL OR p_enabled IS NULL THEN RAISE EXCEPTION 'futures paper worker identity: worker and enabled are required'; END IF;
    PERFORM pg_advisory_xact_lock(public.fpw_identity_lock_key(p_worker));  -- 0055: serializes with promotion, account creation and worker calls
    SELECT * INTO w FROM public.futures_paper_worker_identities WHERE worker_user_id = p_worker FOR UPDATE;
    v_found := FOUND;
    IF NOT p_enabled THEN
      IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker identity: not a registered worker identity'; END IF;
      IF p_label IS NOT NULL AND p_label IS DISTINCT FROM w.label THEN RAISE EXCEPTION 'futures paper worker identity: disabling keeps the label (pass NULL or the current label)'; END IF;
      IF w.enabled THEN
        UPDATE public.futures_paper_worker_identities SET enabled = false, updated_by = v_uid, updated_at = now() WHERE worker_user_id = p_worker;
        INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor) VALUES (p_worker, true, false, w.label, w.label, v_uid);
      END IF;
      RETURN true;
    END IF;
    IF p_label IS NULL OR p_label !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'futures paper worker identity: worker, label (a-z, 0-9, -; 3..40) and enabled are required'; END IF;
    IF p_worker = v_uid OR public.has_role(p_worker, 'admin') OR public.has_role(p_worker, 'super_admin')
       OR EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = p_worker) THEN
      RAISE EXCEPTION 'futures paper worker identity: the worker must be a separate plain user (not an admin, not a paper account owner)';
    END IF;
    -- 0057: (re-)registration pins the worker's current sign-in details; every later worker call compares them.
    v_pin := public.fpw_credential_pin(p_worker);
    IF v_pin IS NULL THEN RAISE EXCEPTION 'futures paper worker identity: the worker must be an existing sign-in user'; END IF;
    INSERT INTO public.futures_paper_worker_identities AS x (worker_user_id, label, enabled, created_by, updated_by)
    VALUES (p_worker, p_label, true, v_uid, v_uid)
    ON CONFLICT (worker_user_id) DO UPDATE SET label = EXCLUDED.label, enabled = true, updated_by = v_uid, updated_at = now();
    INSERT INTO public.futures_paper_worker_credential_pins AS c (worker_user_id, pin, pinned_at, pinned_by) VALUES (p_worker, v_pin, clock_timestamp(), v_uid)
    ON CONFLICT (worker_user_id) DO UPDATE SET pin = EXCLUDED.pin, pinned_at = EXCLUDED.pinned_at, pinned_by = EXCLUDED.pinned_by;
    INSERT INTO public.futures_paper_worker_credential_events (worker_user_id, event, pin, actor) VALUES (p_worker, 'PINNED', v_pin, v_uid);
    IF NOT v_found OR NOT w.enabled OR w.label IS DISTINCT FROM p_label THEN
      INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor)
      VALUES (p_worker, CASE WHEN v_found THEN w.enabled END, true, CASE WHEN v_found THEN w.label END, p_label, v_uid);
    END IF;
    RETURN true;
  END $f$;

  CREATE OR REPLACE FUNCTION public.fpw_id_check(p_account uuid, p_lock boolean) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); v_owner uuid; v_claims jsonb; v_sid text; v_exp numeric; v_created timestamptz; v_not_after timestamptz; v_found boolean; v_pin text; v_pinned_at timestamptz;
  BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
    -- 0055 F4: held for the whole transaction; promotion, account creation and registration of this user wait for it.
    IF p_lock THEN PERFORM pg_advisory_xact_lock_shared(public.fpw_identity_lock_key(v_uid)); END IF;
    IF p_lock THEN PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled FOR SHARE;
    ELSE PERFORM 1 FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid AND enabled; END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: caller is not an enabled worker identity'; END IF;
    -- 0055 L2–L5: the token must belong to a live, young auth session of this caller (signed-out sessions no longer exist).
    BEGIN v_claims := auth.jwt(); EXCEPTION WHEN others THEN v_claims := NULL; END;
    v_sid := v_claims->>'session_id';
    IF v_sid IS NULL OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'futures paper worker: worker session is not active (no session id)';
    END IF;
    BEGIN v_exp := (v_claims->>'exp')::numeric; EXCEPTION WHEN others THEN v_exp := NULL; END;
    IF v_exp IS NULL OR v_exp <= extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (token expired)'; END IF;
    SELECT s.created_at, s.not_after INTO v_created, v_not_after FROM auth.sessions s WHERE s.id = v_sid::uuid AND s.user_id = v_uid;
    v_found := FOUND;
    IF NOT v_found THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (signed out or unknown)'; END IF;
    IF v_not_after IS NOT NULL AND v_not_after <= clock_timestamp() THEN RAISE EXCEPTION 'futures paper worker: worker session is not active (session expired)'; END IF;
    IF v_created IS NULL OR v_created < clock_timestamp() - public.fpw_worker_session_max_age() THEN
      RAISE EXCEPTION 'futures paper worker: worker session is not active (older than the worker maximum session age)';
    END IF;
    -- 0057: the sign-in details must still be those pinned at (re-)registration, and the session must be newer than the
    -- pin, so neither a changed password/email nor a token issued before re-registration restores worker authority.
    SELECT c.pin, c.pinned_at INTO v_pin, v_pinned_at FROM public.futures_paper_worker_credential_pins c WHERE c.worker_user_id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: worker identity has no credential pin (an admin must re-register it)'; END IF;
    IF v_pin IS DISTINCT FROM public.fpw_credential_pin(v_uid) THEN
      RAISE EXCEPTION 'futures paper worker: worker sign-in details changed since registration (an admin must re-register the identity)';
    END IF;
    IF v_created < v_pinned_at THEN RAISE EXCEPTION 'futures paper worker: worker session predates the current registration'; END IF;
    IF public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'super_admin') THEN
      RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it has an admin role)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.futures_paper_accounts WHERE user_id = v_uid) THEN
      RAISE EXCEPTION 'futures paper worker: worker identity is no longer eligible (it owns a paper account)';
    END IF;
    IF p_lock THEN
      SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
        JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
       WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL FOR SHARE OF a, e;
    ELSE
      SELECT a.user_id INTO v_owner FROM public.futures_paper_accounts a
        JOIN public.futures_paper_worker_enrollments e ON e.account_id = a.id AND e.user_id = a.user_id
       WHERE a.id = p_account AND e.worker_user_id = v_uid AND e.revoked_at IS NULL;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'futures paper worker: account not enrolled for this worker identity'; END IF;
    RETURN v_owner;
  END $f$;

  CREATE OR REPLACE FUNCTION public.fpw_record_refusal(p_fn text, p_account uuid, p_state text, p_msg text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  DECLARE v_uid uuid := auth.uid(); v_sid uuid; w public.futures_paper_worker_identities%ROWTYPE; v_pin text; v_obs text; v_revoked integer := 0;
          t public.futures_paper_worker_refusal_tally%ROWTYPE;
  BEGIN
    -- Only registered identities are recorded (anyone else could otherwise fill the tables).
    IF v_uid IS NULL THEN RETURN; END IF;
    SELECT * INTO w FROM public.futures_paper_worker_identities WHERE worker_user_id = v_uid;
    IF NOT FOUND THEN RETURN; END IF;
    BEGIN v_sid := nullif(auth.jwt()->>'session_id', '')::uuid; EXCEPTION WHEN others THEN v_sid := NULL; END;
    -- 0057 credential change: sticky and independent of the cap. Re-verified here (the message alone changes nothing):
    -- disable the identity, revoke every enrollment, end its leases; only an admin re-registration plus owner
    -- re-enrollment restores it. These writes commit with the refusal because the envelope's transaction commits.
    IF p_state = 'P0001' AND p_msg = 'futures paper worker: worker sign-in details changed since registration (an admin must re-register the identity)' THEN
      SELECT c.pin INTO v_pin FROM public.futures_paper_worker_credential_pins c WHERE c.worker_user_id = v_uid;
      v_obs := public.fpw_credential_pin(v_uid);
      IF v_pin IS NOT NULL AND v_pin IS DISTINCT FROM v_obs THEN
        UPDATE public.futures_paper_worker_identities SET enabled = false, updated_by = v_uid, updated_at = now() WHERE worker_user_id = v_uid AND enabled;
        IF FOUND THEN
          INSERT INTO public.futures_paper_worker_identity_changes (worker_user_id, old_enabled, new_enabled, old_label, new_label, actor) VALUES (v_uid, true, false, w.label, w.label, v_uid);
        END IF;
        UPDATE public.futures_paper_worker_leases l SET expires_at = clock_timestamp()
          FROM public.futures_paper_worker_enrollments e WHERE e.worker_user_id = v_uid AND e.account_id = l.account_id AND l.expires_at > clock_timestamp();
        WITH r AS (UPDATE public.futures_paper_worker_enrollments SET revoked_at = now() WHERE worker_user_id = v_uid AND revoked_at IS NULL RETURNING account_id, user_id)
        INSERT INTO public.futures_paper_worker_audit (account_id, user_id, code, actor) SELECT r.account_id, r.user_id, 'ID:REVOKED_CREDENTIALS_CHANGED', 'system:0057' FROM r;
        GET DIAGNOSTICS v_revoked = ROW_COUNT;
        INSERT INTO public.futures_paper_worker_credential_events (worker_user_id, event, pin, observed, enrollments_revoked, actor, session_id)
        VALUES (v_uid, 'CHANGE_DETECTED', v_pin, v_obs, v_revoked, v_uid, v_sid);
      END IF;
    END IF;
    -- 0057 completeness tally: created on first use with the rows recorded before it as baseline; the row lock
    -- serializes this identity's recorders, so counts, cap and rows stay consistent under concurrency.
    INSERT INTO public.futures_paper_worker_refusal_tally (worker_user_id, baseline_rows, recorded_total)
      SELECT v_uid, count(*), count(*) FROM public.futures_paper_worker_refusals WHERE worker_user_id = v_uid
    ON CONFLICT (worker_user_id) DO NOTHING;
    SELECT * INTO t FROM public.futures_paper_worker_refusal_tally WHERE worker_user_id = v_uid FOR UPDATE;
    IF (SELECT count(*) FROM public.futures_paper_worker_refusals WHERE worker_user_id = v_uid AND created_at > clock_timestamp() - interval '10 minutes') >= public.fpw_refusal_record_cap() THEN
      -- Above the cap: no row, but an explicit, monotonic dropped counter (never a silent drop).
      UPDATE public.futures_paper_worker_refusal_tally SET dropped_total = t.dropped_total + 1, first_dropped_at = coalesce(t.first_dropped_at, clock_timestamp()),
             last_dropped_at = clock_timestamp(), updated_at = clock_timestamp() WHERE worker_user_id = v_uid;
      RETURN;
    END IF;
    INSERT INTO public.futures_paper_worker_refusals (worker_user_id, account_id, fn, sqlstate, reason, session_id)
    VALUES (v_uid, p_account, p_fn, CASE WHEN p_state ~ '^[0-9A-Z]{5}$' THEN p_state ELSE 'XX000' END,
            left(regexp_replace(coalesce(p_msg, ''), '[^ -~]', '?', 'g'), 200), v_sid);
    UPDATE public.futures_paper_worker_refusal_tally SET recorded_total = t.recorded_total + 1, updated_at = clock_timestamp() WHERE worker_user_id = v_uid;
  END $f$;

  -- ---------- completeness report (admin + MFA): rows vs counters per worker identity ----------
  CREATE FUNCTION public.fpw_audit_refusal_completeness() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
  BEGIN
    IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') OR NOT public.account_mfa_allowed() THEN RAISE EXCEPTION 'futures paper audit completeness: admin only'; END IF;
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object('worker_user_id', w.id, 'rows', w.n,
               'baseline_rows', t.baseline_rows, 'recorded_total', t.recorded_total, 'dropped_total', t.dropped_total,
               'missing', CASE WHEN t.worker_user_id IS NULL THEN NULL ELSE t.recorded_total - w.n END,
               'first_dropped_at', t.first_dropped_at, 'last_dropped_at', t.last_dropped_at, 'tallied', t.worker_user_id IS NOT NULL) ORDER BY w.id)
        FROM (SELECT x.id, (SELECT count(*) FROM public.futures_paper_worker_refusals r WHERE r.worker_user_id = x.id) AS n
                FROM (SELECT worker_user_id AS id FROM public.futures_paper_worker_refusal_tally UNION SELECT worker_user_id FROM public.futures_paper_worker_refusals) x) w
        LEFT JOIN public.futures_paper_worker_refusal_tally t ON t.worker_user_id = w.id), '[]'::jsonb);
  END $f$;

  -- Rollback-order guard: 0056's rollback (DROP FUNCTION fpw_api_pre_request(), no CASCADE) fails while this
  -- SQL-standard body depends on it. Never granted; calling it would only run the request hook.
  CREATE FUNCTION public.fpw_0057_requires_0056() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT public.fpw_api_pre_request(); END;

  -- ---------- privileges ----------
  REVOKE ALL ON public.futures_paper_worker_credential_pins, public.futures_paper_worker_credential_events, public.futures_paper_worker_refusal_tally FROM PUBLIC, anon, authenticated, service_role;
  ALTER TABLE public.futures_paper_worker_credential_pins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.futures_paper_worker_credential_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.futures_paper_worker_refusal_tally ENABLE ROW LEVEL SECURITY;
  -- No policy and no grant on the three tables: written by the definer functions above, read by the owner and the report.
  REVOKE ALL ON FUNCTION public.fpw_credential_pin(uuid), public.fpw_refusal_tally_guard(), public.fpw_audit_refusal_completeness(), public.fpw_0057_requires_0056()
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.fpw_audit_refusal_completeness() TO authenticated;  -- admin + MFA checked inside
  -- fpw_admin_set_identity, fpw_id_check and fpw_record_refusal keep their 0055 privileges (CREATE OR REPLACE keeps grants).
END
$mig$;
