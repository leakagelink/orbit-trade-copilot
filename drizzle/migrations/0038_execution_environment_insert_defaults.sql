CREATE OR REPLACE FUNCTION public.set_execution_environment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE derived text; is_test boolean; original_id uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.execution_environment IS DISTINCT FROM OLD.execution_environment THEN RAISE EXCEPTION 'Execution environment is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.mode='paper' THEN derived:='paper';
 ELSE
  IF TG_TABLE_NAME='trades' THEN
   original_id := (to_jsonb(NEW)->>'order_id')::uuid;
   SELECT execution_environment INTO derived FROM public.orders WHERE id=original_id;
  END IF;
  IF derived IS NULL OR derived='legacy_unknown' THEN
   SELECT is_testnet INTO is_test FROM public.exchange_connections WHERE id=NEW.exchange_connection_id AND user_id=NEW.user_id;
   derived:=CASE WHEN is_test IS NULL THEN 'legacy_unknown' WHEN is_test THEN 'testnet' ELSE 'production' END;
  END IF;
 END IF;
 -- The column default is only an insert placeholder; the contemporaneous account decides the immutable value.
 IF NEW.execution_environment IS NULL OR NEW.execution_environment='legacy_unknown' THEN NEW.execution_environment:=derived;
 ELSIF NEW.execution_environment<>derived AND derived<>'legacy_unknown' THEN RAISE EXCEPTION 'Execution environment does not match the trading account'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.set_execution_environment() FROM PUBLIC;
ALTER TABLE public.orders ALTER COLUMN execution_environment SET DEFAULT 'legacy_unknown';
ALTER TABLE public.positions ALTER COLUMN execution_environment SET DEFAULT 'legacy_unknown';
ALTER TABLE public.trades ALTER COLUMN execution_environment SET DEFAULT 'legacy_unknown';