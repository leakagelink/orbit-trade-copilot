-- Scheduled Autopilot model steps run as async database HTTP requests, because scheduler calls last only a few
-- seconds while a Claude reply can take a minute. Only the AI Prime Tech connector route is reachable, and only
-- server code (service role) may submit or read requests.
CREATE OR REPLACE FUNCTION public.ai_async_submit(_url text, _headers jsonb, _body jsonb, _timeout_ms integer DEFAULT 180000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
BEGIN
  IF _url NOT LIKE 'https://connector-gateway.lovable.dev/udc_ai_prime_tech/v1/%' THEN
    RAISE EXCEPTION 'AI request destination not allowed';
  END IF;
  IF _timeout_ms < 1000 OR _timeout_ms > 300000 THEN
    RAISE EXCEPTION 'AI request timeout out of range';
  END IF;
  RETURN net.http_post(url := _url, body := _body, headers := _headers, timeout_milliseconds := _timeout_ms);
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_async_result(_id bigint)
RETURNS TABLE (status_code integer, content text, timed_out boolean, error_msg text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, net
AS $$
  SELECT r.status_code, r.content, r.timed_out, r.error_msg FROM net._http_response r WHERE r.id = _id
$$;

REVOKE ALL ON FUNCTION public.ai_async_submit(text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_async_result(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_async_submit(text, jsonb, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_async_result(bigint) TO service_role;